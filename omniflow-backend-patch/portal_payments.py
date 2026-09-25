"""Payment gateways (JazzCash / Easypaisa hosted checkout) for checkout
links. Everything is OFF until the owner stores credentials. The customer
pays from the public /c/ page: GET /public/checkout/<token>/pay builds a
signed provider form (auto-submit HTML); the provider posts back to
/public/payments/callback/<intent> where the HMAC is verified BEFORE the
payment is applied to the link (paid_amount += amount, auto-flip to paid).
No secrets ever leave the server; settings GETs return last-4 masks only."""
import hashlib
import hmac
import json
import logging
import secrets
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_checkout
import portal_db

bp = Blueprint("portal_payments", __name__, url_prefix="/api/v1/portal")
public_bp = Blueprint("portal_payments_public", __name__,
                      url_prefix="/api/v1/public")

logger = logging.getLogger(__name__)
SETTINGS_TABLE = "portal_payment_settings"
INTENTS_TABLE = "portal_payment_intents"
_SETTINGS_DDL_READY = False
_INTENTS_DDL_READY = False
PROVIDERS = ("jazzcash", "easypaisa", "stripe")
MAX_AMOUNT = 100000


def _ensure_settings_table(conn) -> None:
    global _SETTINGS_DDL_READY
    if _SETTINGS_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(SETTINGS_TABLE) +
            " (client_id BIGINT PRIMARY KEY,"
            " provider TEXT NOT NULL DEFAULT 'jazzcash',"
            " enabled BOOLEAN NOT NULL DEFAULT FALSE,"
            " sandbox BOOLEAN NOT NULL DEFAULT TRUE,"
            " merchant_id TEXT NOT NULL DEFAULT '',"
            " password TEXT NOT NULL DEFAULT '',"
            " salt TEXT NOT NULL DEFAULT '',"
            " store_id TEXT NOT NULL DEFAULT '',"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
    conn.commit()
    _SETTINGS_DDL_READY = True


def _ensure_intents_table(conn) -> None:
    global _INTENTS_DDL_READY
    if _INTENTS_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(INTENTS_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " link_id BIGINT NOT NULL,"
            " token TEXT NOT NULL UNIQUE,"
            " provider TEXT NOT NULL DEFAULT '',"
            " amount NUMERIC(12,2) NOT NULL DEFAULT 0,"
            " status TEXT NOT NULL DEFAULT 'pending',"
            " provider_ref TEXT NOT NULL DEFAULT '',"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS portal_payment_intents_client_idx ON "
            + portal_db._q(INTENTS_TABLE) + " (client_id, id DESC)"
        )
    conn.commit()
    _INTENTS_DDL_READY = True


def _load_settings(cur, client_id):
    cur.execute(
        "SELECT provider, enabled, sandbox, merchant_id, password, salt,"
        " store_id FROM " + portal_db._q(SETTINGS_TABLE) +
        " WHERE client_id = %s LIMIT 1",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    return rows[0] if rows else None


def _stripe_secret() -> str:
    """Platform Stripe secret key (admin panel first, env fallback)."""
    try:
        import platform_settings
        stored = platform_settings.get_group("payments")
        return (str(stored.get("secret_key") or "").strip()
                or os.environ.get("STRIPE_SECRET_KEY", "").strip())
    except Exception:
        return os.environ.get("STRIPE_SECRET_KEY", "").strip()


def _configured(row) -> bool:
    if row is None or not row.get("enabled"):
        return False
    if str(row.get("provider") or "") == "stripe":
        return bool(_stripe_secret())
    if str(row.get("provider") or "") == "jazzcash":
        return bool(row.get("merchant_id")) and bool(row.get("salt"))
    if str(row.get("provider") or "") == "easypaisa":
        return bool(row.get("store_id"))
    return False


def _mask(value: str) -> str:
    value = str(value or "")
    if len(value) <= 4:
        return "****"
    return "****" + value[-4:]


def jazzcash_hash(salt: str, fields: Dict[str, str]) -> str:
    """HMAC-SHA256 over sorted non-empty fields (JazzCash v2.0 spec)."""
    msg = "&".join(
        str(k) + "=" + str(v)
        for k, v in sorted(fields.items())
        if str(v or "") != "" and str(k) != "pp_SecureHash"
    )
    return hmac.new(
        str(salt or "").encode("utf-8"), msg.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest().upper()


def easypaisa_hash(hash_key: str, fields: Dict[str, str]) -> str:
    msg = "&".join(
        str(k) + "=" + str(v)
        for k, v in sorted(fields.items())
        if str(v or "") != ""
    )
    return hmac.new(
        str(hash_key or "").encode("utf-8"), msg.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest().upper()


@bp.get("/payments/settings")
def get_payment_settings():
    principal, error = portal_checkout._principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_settings_table(conn)
            with conn.cursor() as cur:
                row = _load_settings(cur, principal["client_id"])
        finally:
            conn.close()
    except Exception as error:
        logger.warning("payment settings read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "payment settings read")[0]), 503
    row = row or {}
    provider = str(row.get("provider") or "jazzcash")
    return jsonify({"settings": {
        "provider": provider if provider in PROVIDERS else "jazzcash",
        "enabled": bool(row.get("enabled")),
        "sandbox": bool(row.get("sandbox")),
        "configured": _configured(row),
        "merchant_id_masked": _mask(row.get("merchant_id")),
        "store_id_masked": _mask(row.get("store_id")),
    }}), 200


@bp.put("/payments/settings")
def save_payment_settings():
    principal, error = portal_checkout._principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    forbidden = portal_checkout.ensure_money_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    provider = str(payload.get("provider") or "jazzcash").strip().lower()
    if provider not in PROVIDERS:
        provider = "jazzcash"
    merchant_id = str(payload.get("merchant_id") or "").strip()[:64]
    password = str(payload.get("password") or "").strip()[:128]
    salt = str(payload.get("salt") or "").strip()[:128]
    store_id = str(payload.get("store_id") or "").strip()[:64]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_settings_table(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(SETTINGS_TABLE) +
                    " (client_id, provider, enabled, sandbox, merchant_id,"
                    " password, salt, store_id, updated_at)"
                    " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW())"
                    " ON CONFLICT (client_id) DO UPDATE SET provider ="
                    " EXCLUDED.provider, enabled = EXCLUDED.enabled,"
                    " sandbox = EXCLUDED.sandbox, merchant_id ="
                    " EXCLUDED.merchant_id, password = EXCLUDED.password,"
                    " salt = EXCLUDED.salt, store_id = EXCLUDED.store_id,"
                    " updated_at = NOW()",
                    (principal["client_id"], provider,
                     bool(payload.get("enabled")),
                     bool(payload.get("sandbox")), merchant_id,
                     password, salt, store_id),
                )
                portal_db.log_action(
                    cur, principal["client_id"], "payments.settings",
                    "customer_user", principal.get("user_id"), None,
                    ("Payment gateway " + provider
                     + (" enabled" if payload.get("enabled")
                        else " saved"))[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("payment settings save failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "payment settings save")[0]), 503
    return jsonify({"ok": True}), 200


@bp.get("/payments/intents")
def list_payment_intents():
    principal, error = portal_checkout._principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_intents_table(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, token, provider, amount, status,"
                    " created_at FROM " + portal_db._q(INTENTS_TABLE) +
                    " WHERE client_id = %s ORDER BY id DESC LIMIT 20",
                    (principal["client_id"],),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("payment intents read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "payment intents read")[0]), 503
    return jsonify({"intents": [{
        "id": int(row.get("id") or 0),
        "token": str(row.get("token") or "")[:8],
        "provider": str(row.get("provider") or ""),
        "amount": round(float(row.get("amount") or 0), 2),
        "status": str(row.get("status") or "pending"),
        "created_at": portal_checkout._iso(row.get("created_at")),
    } for row in rows]}), 200


def _build_provider_form(settings, intent_token, due, base_url):
    """Return (post_url, fields) for the configured provider."""
    provider = str(settings.get("provider") or "jazzcash")
    sandbox = bool(settings.get("sandbox"))
    if provider == "easypaisa":
        url = ("https://easypaystg.easypaisa.com.pk/easypay/Index.jsf"
               if sandbox
               else "https://easypay.easypaisa.com.pk/easypay/Index.jsf")
        fields = {
            "storeId": str(settings.get("store_id") or ""),
            "amount": str(due),
            "postBackURL": base_url + "/api/v1/public/payments/callback/"
                           + intent_token,
            "orderRefNum": intent_token[:20],
            "expiryDate": "2029-12-31 00:00:00",
            "autoRedirect": "1",
            "paymentMethod": "MA_PAYMENT_METHOD",
            "emailAddr": "",
            "mobileNum": "",
        }
        return url, fields
    url = ("https://sandbox.jazzcash.com.pk/CustomerPortal/"
           "transactionmanagement/merchantform"
           if sandbox else
           "https://payments.jazzcash.com.pk/CustomerPortal/"
           "transactionmanagement/merchantform")
    now = datetime.now()
    fields = {
        "pp_Version": "1.1",
        "pp_TxnType": "MWALLET",
        "pp_Language": "EN",
        "pp_MerchantID": str(settings.get("merchant_id") or ""),
        "pp_Password": str(settings.get("password") or ""),
        "pp_TxnRefNo": "T" + now.strftime("%Y%m%d%H%M%S")
                       + intent_token[:6].upper(),
        "pp_Amount": str(int(round(float(due) * 100))),
        "pp_TxnDateTime": now.strftime("%Y%m%d%H%M%S"),
        "pp_TxnExpiryDateTime": (now + timedelta(hours=1))
        .strftime("%Y%m%d%H%M%S"),
        "pp_BillReference": intent_token[:16],
        "pp_Description": "Order payment",
        "pp_ReturnURL": base_url + "/api/v1/public/payments/callback/"
                        + intent_token,
        "ppmpf_1": intent_token[:20],
    }
    fields["pp_SecureHash"] = jazzcash_hash(settings.get("salt"), fields)
    return url, fields


def _render_form(post_url, fields):
    inputs = "\n".join(
        '<input type="hidden" name="' + str(k) + '" value="' + str(v)
        .replace("&", "&amp;").replace('"', "&quot;") + '" />'
        for k, v in fields.items())
    return ('<!doctype html><html><head><meta charset="utf-8">'
            "<title>Redirecting to payment...</title></head>"
            '<body onload="document.forms[0].submit()">'
            '<form method="POST" action="' + post_url + '">' + inputs
            + '<noscript><button type="submit">Continue to payment'
            "</button></noscript></form>"
            "<p>Redirecting to payment...</p></body></html>")


def _render_message(title, body):
    return ('<!doctype html><html><head><meta charset="utf-8">'
            "<title>" + title + "</title></head>"
            '<body style="font-family:sans-serif;text-align:center;'
            'padding-top:4rem"><h1>' + title + "</h1><p>" + body
            + "</p></body></html>")


@public_bp.get("/checkout/<token>/payinfo")
def public_payinfo(token: str):
    """Public: can this link be paid online right now (and how much)?"""
    token = str(token or "").strip()[:64]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            portal_checkout._ensure_checkout_tables(conn)
            _ensure_settings_table(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT total, paid_amount, status FROM "
                    + portal_db._q(portal_checkout.LINKS_TABLE) +
                    " WHERE token = %s LIMIT 1",
                    (token,),
                )
                rows = portal_db.rows(cur)
                settings = _load_settings(cur, 0) if not rows else \
                    _load_settings(cur, rows[0].get("client_id"))
        finally:
            conn.close()
    except Exception as error:
        logger.warning("payment payinfo failed: %s", error)
        return {"error": {"code": "portal_unavailable",
                          "message": "Try again shortly."}}, 503
    if not rows:
        return {"enabled": False, "due": 0}, 200
    due = round(
        float(rows[0].get("total") or 0)
        - float(rows[0].get("paid_amount") or 0), 2)
    open_link = (rows[0].get("status") or "open") == "open"
    return {"enabled": bool(_configured(settings)) and open_link
            and due > 0,
            "due": max(due, 0)}, 200


@public_bp.get("/checkout/<token>/pay")
def public_pay(token: str):
    token = str(token or "").strip()[:64]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            portal_checkout._ensure_checkout_tables(conn)
            _ensure_settings_table(conn)
            _ensure_intents_table(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, client_id, contact_id, title, total,"
                    " paid_amount, status, expires_at FROM "
                    + portal_db._q(portal_checkout.LINKS_TABLE) +
                    " WHERE token = %s LIMIT 1",
                    (token,),
                )
                rows = portal_db.rows(cur)
                if not rows:
                    return _render_message(
                        "Link not found",
                        "This order link is not valid."), 404
                link = rows[0]
                settings = _load_settings(cur, link.get("client_id"))
                if not _configured(settings):
                    return _render_message(
                        "Online payment is off",
                        "Ask the business for payment details."), 400
                due = round(
                    float(link.get("total") or 0)
                    - float(link.get("paid_amount") or 0), 2)
                if (link.get("status") or "open") != "open" or due <= 0:
                    return _render_message(
                        "Nothing to pay",
                        "This order is already settled."), 400
                intent_token = secrets.token_urlsafe(16)
                base_url = request.host_url.rstrip("/")
                if str(settings.get("provider") or "") == "stripe":
                    session = _stripe_create_session(
                        _stripe_secret(), intent_token, due,
                        str(link.get("title") or "Order"), base_url)
                    if "_error" in session or not session.get("url"):
                        conn.rollback()
                        return _render_message(
                            "Payment unavailable",
                            "Stripe rejected the session - check the"
                            " platform keys."), 502
                    cur.execute(
                        "INSERT INTO " + portal_db._q(INTENTS_TABLE) +
                        " (client_id, link_id, token, provider, amount)"
                        " VALUES (%s, %s, %s, %s, %s)",
                        (link.get("client_id"), link.get("id"),
                         intent_token, "stripe", due),
                    )
                    portal_db.log_action(
                        cur, link.get("client_id"), "payment.intent",
                        "system", None, None,
                        ("Stripe intent " + intent_token[:8]
                         + " for " + str(due))[:200],
                    )
                    conn.commit()
                    from flask import redirect
                    return redirect(str(session["url"]), 302)
                post_url, fields = _build_provider_form(
                    settings, intent_token, due, base_url)
                cur.execute(
                    "INSERT INTO " + portal_db._q(INTENTS_TABLE) +
                    " (client_id, link_id, token, provider, amount)"
                    " VALUES (%s, %s, %s, %s, %s)",
                    (link.get("client_id"), link.get("id"), intent_token,
                     str(settings.get("provider") or ""), due),
                )
                portal_db.log_action(
                    cur, link.get("client_id"), "payment.intent", "system",
                    None, None,
                    ("Intent " + intent_token[:8] + " for "
                     + str(due))[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("payment intent failed: %s", error)
        return _render_message(
            "Payment unavailable", "Try again shortly."), 503
    return _render_form(post_url, fields), 200


@public_bp.post("/payments/callback/<intent_token>")
def public_callback(intent_token: str):
    intent_token = str(intent_token or "").strip()[:64]
    form = {k: str(v) for k, v in request.form.items()}
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_intents_table(conn)
            _ensure_settings_table(conn)
            portal_checkout._ensure_checkout_tables(conn)
            with conn.cursor() as cur:
                try:
                    import portal_ratelimit

                    if not portal_ratelimit.allow(
                        cur,
                        "paycb:" + intent_token,
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
                cur.execute(
                    "SELECT id, client_id, link_id, amount, status,"
                    " provider FROM " + portal_db._q(INTENTS_TABLE) +
                    " WHERE token = %s LIMIT 1",
                    (intent_token,),
                )
                rows = portal_db.rows(cur)
                if not rows:
                    return _render_message(
                        "Payment not found",
                        "Unknown payment reference."), 404
                intent = rows[0]
                if intent.get("status") == "paid":
                    return _render_message(
                        "Already paid",
                        "This payment was already recorded."), 200
                settings = _load_settings(cur, intent.get("client_id"))
                if str(intent.get("provider") or "") == "jazzcash":
                    if (str(form.get("pp_RResponseCode") or "")
                            != "000" or not settings
                            or jazzcash_hash(settings.get("salt"), form)
                            != str(form.get("pp_SecureHash") or "")):
                        return _render_message(
                            "Verification failed",
                            "The payment could not be verified."), 400
                    provider_ref = str(form.get("pp_TxnRefNo") or "")
                else:
                    if (str(form.get("responseCode") or "")
                            != "000" or not settings
                            or easypaisa_hash(
                                settings.get("salt"), form)
                            != str(form.get("paymentHash") or "")):
                        return _render_message(
                            "Verification failed",
                            "The payment could not be verified."), 400
                    provider_ref = str(form.get("transactionRefNum") or "")
                cur.execute(
                    "UPDATE " + portal_db._q(INTENTS_TABLE) +
                    " SET status = 'paid', provider_ref = %s,"
                    " updated_at = NOW()"
                    " WHERE id = %s AND status = 'pending' RETURNING id",
                    (provider_ref[:64], intent.get("id")),
                )
                applied = portal_db.rows(cur)
                if applied:
                    amount = round(float(intent.get("amount") or 0), 2)
                    cur.execute(
                        "UPDATE " + portal_db._q(portal_checkout.LINKS_TABLE)
                        + " SET paid_amount = COALESCE(paid_amount, 0) + %s,"
                        " status = CASE WHEN COALESCE(paid_amount, 0) + %s"
                        " >= total THEN 'paid' ELSE status END,"
                        " updated_at = NOW()"
                        " WHERE id = %s AND client_id = %s"
                        " AND status = 'open' RETURNING paid_amount, total",
                        (amount, amount, intent.get("link_id"),
                         intent.get("client_id")),
                    )
                    updated = portal_db.rows(cur)
                    portal_db.log_action(
                        cur, intent.get("client_id"),
                        "payment.gateway_paid", "system", None, None,
                        ("Gateway payment " + str(amount) + " on link "
                         + str(intent.get("link_id"))
                         + (f" (paid "
                            + str(round(float(updated[0].get(
                                "paid_amount") or 0), 2)) + "/"
                            + str(round(float(updated[0].get(
                                "total") or 0), 2)) + ")"
                            if updated else ""))[:200],
                    )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("payment callback failed: %s", error)
        return _render_message(
            "Payment unavailable", "Try again shortly."), 503
    return _render_message(
        "Payment received",
        "Thank you! The business can see your payment now."), 200


_STRIPE_API = "https://api.stripe.com/v1/checkout/sessions"


def _stripe_create_session(secret: str, intent_token: str, amount: float,
                           title: str, base_url: str) -> Dict[str, Any]:
    """Create one Stripe Checkout Session; {'url': ...} or {'_error'}."""
    try:
        import urllib.parse
        import urllib.request
        units = int(round(float(amount) * 100))
        if units <= 0:
            return {"_error": "amount"}
        callback = (base_url + "/api/v1/public/payments/callback/"
                    + urllib.parse.quote(intent_token, safe="")
                    + "?stripe_return=1")
        body = urllib.parse.urlencode({
            "mode": "payment",
            "success_url": callback,
            "cancel_url": base_url,
            "client_reference_id": intent_token,
            "line_items[0][quantity]": "1",
            "line_items[0][price_data][currency]": "pkr",
            "line_items[0][price_data][unit_amount]": str(units),
            "line_items[0][price_data][product_data][name]":
                (title or "Order")[:120],
        }).encode("utf8")
        req = urllib.request.Request(
            _STRIPE_API, data=body, method="POST",
            headers={"Authorization": "Bearer " + secret,
                     "Content-Type": "application/x-www-form-urlencoded"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf8"))
        url = str(data.get("url") or "")
        return {"url": url} if url else {"_error": "no session url"}
    except Exception as error:
        return {"_error": str(error) or "stripe request failed"}


def _stripe_session_status(secret: str, session_id: str) -> Dict[str, Any]:
    """GET one session; dict or {'_error': ...}."""
    try:
        import urllib.parse
        import urllib.request
        req = urllib.request.Request(
            _STRIPE_API + "/" + urllib.parse.quote(session_id, safe=""),
            headers={"Authorization": "Bearer " + secret},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf8"))
    except Exception as error:
        return {"_error": str(error) or "stripe request failed"}


def _mark_stripe_paid(conn, intent_token: str, provider_ref: str):
    """Shared tail of the stripe return: verify -> mark -> update link."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, client_id, link_id, amount, status, provider"
            " FROM " + portal_db._q(INTENTS_TABLE) +
            " WHERE token = %s AND provider = 'stripe' LIMIT 1",
            (intent_token,),
        )
        rows = portal_db.rows(cur)
        if not rows:
            return _render_message(
                "Payment not found", "Unknown payment reference."), 404
        intent = rows[0]
        if intent.get("status") == "paid":
            return _render_message(
                "Already paid", "This payment was already recorded."), 200
        cur.execute(
            "UPDATE " + portal_db._q(INTENTS_TABLE) +
            " SET status = 'paid', provider_ref = %s, updated_at = NOW()"
            " WHERE id = %s AND status = 'pending' RETURNING id",
            (provider_ref[:64], intent.get("id")),
        )
        applied = portal_db.rows(cur)
        if applied:
            amount = round(float(intent.get("amount") or 0), 2)
            cur.execute(
                "UPDATE " + portal_db._q(portal_checkout.LINKS_TABLE)
                + " SET paid_amount = COALESCE(paid_amount, 0) + %s,"
                " status = CASE WHEN COALESCE(paid_amount, 0) + %s"
                " >= total THEN 'paid' ELSE status END,"
                " updated_at = NOW()"
                " WHERE id = %s AND client_id = %s"
                " AND status = 'open' RETURNING paid_amount, total",
                (amount, amount, intent.get("link_id"),
                 intent.get("client_id")),
            )
            portal_db.log_action(
                cur, intent.get("client_id"), "payment.gateway_paid",
                "system", None, None,
                ("Stripe payment " + str(amount) + " on link "
                 + str(intent.get("link_id")))[:200],
            )
        conn.commit()
    return _render_message(
        "Payment received",
        "Thank you! The business can see your payment now."), 200


@public_bp.get("/payments/callback/<intent_token>")
def public_stripe_return(intent_token: str):
    """Stripe success_url lands here (GET) - verify then mark paid."""
    intent_token = str(intent_token or "").strip()[:64]
    session_id = str(request.args.get("session_id") or "").strip()[:200]
    secret = _stripe_secret()
    if not secret:
        return _render_message(
            "Payment unavailable", "Stripe is not configured."), 503
    status = (_stripe_session_status(secret, session_id)
              if session_id else {"_error": "missing session_id"})
    if status.get("payment_status") != "paid":
        return _render_message(
            "Payment not completed",
            "The payment did not go through - you can try again."), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_intents_table(conn)
            portal_checkout._ensure_checkout_tables(conn)
            return _mark_stripe_paid(
                conn, intent_token,
                str(status.get("payment_intent")
                    or status.get("id") or "stripe"))
        finally:
            conn.close()
    except Exception as error:
        logger.warning("stripe return failed: %s", error)
        return _render_message(
            "Payment unavailable", "Try again shortly."), 503
