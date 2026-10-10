"""§261 OmniFlow Control Plane - client billing for the owner (batch 261).

Owner-only (service key, same guard as admin_users). Records what each client
owes OmniFlow: a fixed subscription fee, or a commission on sales. Payments are
entered by hand for now; a payment gateway comes later. Expiry either only
flags the client, or moves the client to the Free plan after a grace period,
as the saved setting says. Nothing is hardcoded: currency, commission base,
expiry mode, grace days and the "expiring soon" window are rows in
portal_billing_settings.

Ledger rule: a client's fee and commission are counted from billed_from up to
today. Payments received in that range are set against the amount, so
pending = due - paid (never below zero). Expiry is separate: it only says until
when the client's plan is paid.

Routes (prefix /api/v1/admin/billing):
  GET    ""                              overview: settings, clients, totals
  PUT    "/settings"                     save settings
  PUT    "/clients/<client_id>"          save one client's billing plan
  POST   "/clients/<client_id>/payments" record a payment
  DELETE "/payments/<payment_id>"        delete a mistaken payment

The client panel is affected only through plan_after_expiry(), which
portal_plans._load_plan calls. A client without a billing row is unchanged.
"""

import logging
from datetime import date
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Callable, Dict, List, Optional

from flask import Blueprint, jsonify, request

import portal_auth
import portal_db

log = logging.getLogger("omniflow.portal-billing")

bp = Blueprint("portal_billing", __name__, url_prefix="/api/v1/admin/billing")

SETTINGS = "portal_billing_settings"
CLIENTS = "portal_client_billing"
PAYMENTS = "portal_client_payments"
LINKS = "portal_checkout_links"
PROFILES = "portal_profiles"
DROP_PLAN = "free"  # the Free tier key in portal_plans.PLANS

KINDS = ("free", "subscription", "commission")
COMMISSION_BASES = ("paid_before_cancel", "paid_net", "delivered")
EXPIRY_MODES = ("flag", "grace_then_free", "free_now")
PAYMENT_KINDS = ("fee", "commission")
CENT = Decimal("0.01")
MAX_MONEY = Decimal("9999999999.99")
RECENT_PAYMENTS = 5

_CREATE_STAMP_FN = """
CREATE OR REPLACE FUNCTION portal_billing_stamp_paid() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('paid', 'shipped', 'delivered') AND NEW.paid_at IS NULL THEN
    NEW.paid_at := NOW();
  END IF;
  RETURN NEW;
END;
$$
"""

# Adds paid_at to the checkout links once, backfills it from the last update,
# and keeps it stamped from then on (the trigger fires on any code path).
_LINKS_PAID_AT = """
DO $$
BEGIN
  IF to_regclass('portal_checkout_links') IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'portal_checkout_links' AND column_name = 'paid_at') THEN
    ALTER TABLE portal_checkout_links ADD COLUMN paid_at TIMESTAMPTZ;
    UPDATE portal_checkout_links SET paid_at = updated_at
     WHERE paid_at IS NULL AND status IN ('paid', 'shipped', 'delivered');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'portal_checkout_links_paid_at') THEN
    CREATE TRIGGER portal_checkout_links_paid_at
      BEFORE INSERT OR UPDATE OF status ON portal_checkout_links
      FOR EACH ROW EXECUTE PROCEDURE portal_billing_stamp_paid();
  END IF;
END
$$
"""

_DDL = (
    "CREATE TABLE IF NOT EXISTS " + SETTINGS + " ("
    " id SMALLINT PRIMARY KEY CHECK (id = 1),"
    " currency TEXT NOT NULL DEFAULT 'PKR' CHECK (currency ~ '^[A-Z]{3}$'),"
    " commission_base TEXT NOT NULL DEFAULT 'paid_net'"
    " CHECK (commission_base IN ('paid_before_cancel', 'paid_net', 'delivered')),"
    " expiry_mode TEXT NOT NULL DEFAULT 'flag'"
    " CHECK (expiry_mode IN ('flag', 'grace_then_free', 'free_now')),"
    " grace_days INTEGER NOT NULL DEFAULT 7 CHECK (grace_days BETWEEN 0 AND 365),"
    " expiring_soon_days INTEGER NOT NULL DEFAULT 7"
    " CHECK (expiring_soon_days BETWEEN 0 AND 365),"
    " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "INSERT INTO " + SETTINGS + " (id) VALUES (1) ON CONFLICT (id) DO NOTHING",
    "CREATE TABLE IF NOT EXISTS " + CLIENTS + " ("
    " client_id BIGINT PRIMARY KEY,"
    " kind TEXT NOT NULL DEFAULT 'free'"
    " CHECK (kind IN ('free', 'subscription', 'commission')),"
    " plan_label TEXT NOT NULL DEFAULT '',"
    " fee_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),"
    " period_days INTEGER NOT NULL DEFAULT 30 CHECK (period_days BETWEEN 1 AND 3660),"
    " commission_percent NUMERIC(5,2) NOT NULL DEFAULT 0"
    " CHECK (commission_percent BETWEEN 0 AND 100),"
    " billed_from DATE NOT NULL DEFAULT CURRENT_DATE,"
    " expires_on DATE,"
    " note TEXT NOT NULL DEFAULT '',"
    " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS " + PAYMENTS + " ("
    " id BIGSERIAL PRIMARY KEY,"
    " client_id BIGINT NOT NULL,"
    " kind TEXT NOT NULL CHECK (kind IN ('fee', 'commission')),"
    " amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),"
    " received_on DATE NOT NULL,"
    " method TEXT NOT NULL DEFAULT '',"
    " reference TEXT NOT NULL DEFAULT '',"
    " note TEXT NOT NULL DEFAULT '',"
    " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE INDEX IF NOT EXISTS portal_client_payments_client_idx"
    " ON " + PAYMENTS + " (client_id, received_on)",
    _CREATE_STAMP_FN,
    _LINKS_PAID_AT,
)

# Commission base: which checkout links count, and by which date.
_SALES_SQL = {
    "paid_before_cancel": "paid_at IS NOT NULL AND paid_at::date BETWEEN %s AND %s",
    "paid_net": "status IN ('paid', 'shipped', 'delivered')"
                " AND created_at::date BETWEEN %s AND %s",
    "delivered": "status = 'delivered' AND created_at::date BETWEEN %s AND %s",
}

# Clients whose expiry drops them to Free (only in grace_then_free / free_now).
_DROP_SQL = (
    "SELECT 1 FROM " + CLIENTS + " b JOIN " + SETTINGS + " s ON s.id = 1"
    " WHERE b.client_id = %s AND b.expires_on IS NOT NULL"
    " AND s.expiry_mode <> 'flag'"
    " AND CURRENT_DATE > b.expires_on + CASE WHEN s.expiry_mode = 'free_now'"
    " THEN 0 ELSE s.grace_days END LIMIT 1"
)


class BadInput(ValueError):
    """Input the owner must correct. The message is shown as it is."""


@bp.before_request
def _guard():
    if request.method == "OPTIONS":
        return None
    if not portal_auth.service_key_ok():
        return jsonify({"error": {"code": "forbidden",
                                  "message": "Service key missing or invalid."}}), 403
    return None


def _ensure(cur) -> None:
    for statement in _DDL:
        cur.execute(statement)


_READY = {"done": False}


def _run(work: Callable[[Any], Any]) -> Any:
    """Run work(cur) in one transaction, with the billing tables ready.

    The DDL runs once per instance, and the flag is set only after a commit: a failed
    transaction rolls the DDL back, so the next request runs it again."""
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            if not _READY["done"]:
                _ensure(cur)
            result = work(cur)
        conn.commit()
        _READY["done"] = True
        return result
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ---- input checks ---------------------------------------------------------

def _body() -> Dict[str, Any]:
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        raise BadInput("Send a JSON object.")
    return payload


def _text(payload: Dict[str, Any], key: str, limit: int, required: bool = False) -> str:
    text = "" if payload.get(key) is None else str(payload.get(key)).strip()
    if required and not text:
        raise BadInput(key + " is required.")
    if len(text) > limit:
        raise BadInput(key + " is too long (max " + str(limit) + " characters).")
    return text


def _choice(payload: Dict[str, Any], key: str, options: tuple) -> str:
    value = str(payload.get(key) or "").strip()
    if value not in options:
        raise BadInput(key + " must be one of: " + ", ".join(options) + ".")
    return value


def _whole(payload: Dict[str, Any], key: str, low: int, high: int) -> int:
    try:
        number = int(payload.get(key))
    except (TypeError, ValueError):
        raise BadInput(key + " must be a whole number.")
    if number < low or number > high:
        raise BadInput(key + " must be between " + str(low) + " and " + str(high) + ".")
    return number


def _money(payload: Dict[str, Any], key: str, minimum: Decimal) -> Decimal:
    try:
        value = Decimal(str(payload.get(key))).quantize(CENT, rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        raise BadInput(key + " must be a number.")
    if not value.is_finite() or value < minimum or value > MAX_MONEY:
        raise BadInput(key + " must be between " + str(minimum) + " and " + str(MAX_MONEY) + ".")
    return value


def _percent(payload: Dict[str, Any], key: str) -> Decimal:
    value = _money(payload, key, Decimal("0"))
    if value > Decimal("100"):
        raise BadInput(key + " must be between 0 and 100.")
    return value


def _day(payload: Dict[str, Any], key: str, required: bool) -> Optional[date]:
    raw = str(payload.get(key) or "").strip()
    if not raw:
        if required:
            raise BadInput(key + " is required (YYYY-MM-DD).")
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError:
        raise BadInput(key + " must be a date (YYYY-MM-DD).")


def _settings_input(payload: Dict[str, Any]) -> Dict[str, Any]:
    currency = str(payload.get("currency") or "").strip().upper()
    if len(currency) != 3 or not currency.isascii() or not currency.isalpha():
        raise BadInput("currency must be a 3-letter code, for example PKR.")
    return {
        "currency": currency,
        "commission_base": _choice(payload, "commission_base", COMMISSION_BASES),
        "expiry_mode": _choice(payload, "expiry_mode", EXPIRY_MODES),
        "grace_days": _whole(payload, "grace_days", 0, 365),
        "expiring_soon_days": _whole(payload, "expiring_soon_days", 0, 365),
    }


def _client_input(payload: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "kind": _choice(payload, "kind", KINDS),
        "plan_label": _text(payload, "plan_label", 80),
        "fee_amount": _money(payload, "fee_amount", Decimal("0")),
        "period_days": _whole(payload, "period_days", 1, 3660),
        "commission_percent": _percent(payload, "commission_percent"),
        "billed_from": _day(payload, "billed_from", True),
        "expires_on": _day(payload, "expires_on", False),
        "note": _text(payload, "note", 300),
    }


def _payment_input(payload: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "kind": _choice(payload, "kind", PAYMENT_KINDS),
        "amount": _money(payload, "amount", CENT),
        "received_on": _day(payload, "received_on", True),
        "method": _text(payload, "method", 40),
        "reference": _text(payload, "reference", 80),
        "note": _text(payload, "note", 200),
    }


# ---- derived numbers ------------------------------------------------------

def _num(value: Any) -> float:
    return float(Decimal(str(value or 0)).quantize(CENT, rounding=ROUND_HALF_UP))


def _iso(value: Any) -> Optional[str]:
    return value.isoformat() if isinstance(value, date) else None


def _expiry(expires_on: Optional[date], today: date, mode: str,
            grace_days: int, soon_days: int) -> Dict[str, Any]:
    """State of the paid-through date. dropped is True when the Free rule applies."""
    if expires_on is None:
        return {"state": "none", "days_left": None, "dropped": False}
    days_left = (expires_on - today).days
    if days_left >= 0:
        state = "expiring_soon" if days_left <= soon_days else "active"
        return {"state": state, "days_left": days_left, "dropped": False}
    if mode == "flag":
        return {"state": "expired", "days_left": days_left, "dropped": False}
    allowed = 0 if mode == "free_now" else grace_days
    if (today - expires_on).days > allowed:
        return {"state": "dropped_free", "days_left": days_left, "dropped": True}
    return {"state": "grace", "days_left": days_left, "dropped": False}


def _periods_due(billed_from: date, today: date, period_days: int) -> int:
    if today < billed_from:
        return 0
    return (today - billed_from).days // period_days + 1


def _count(views: List[Dict[str, Any]], key: str, value: Any) -> int:
    return sum(1 for view in views if view.get(key) == value)


def _totals(views: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "clients": len(views),
        "subscription": _count(views, "kind", "subscription"),
        "commission": _count(views, "kind", "commission"),
        "free": _count(views, "kind", "free"),
        "unset": _count(views, "kind", "unset"),
        "fee_pending": _num(sum(view["fee_pending"] for view in views)),
        "commission_pending": _num(sum(view["commission_pending"] for view in views)),
        "payment_pending": _num(sum(view["payment_pending"] for view in views)),
        "expiring_soon": _count(views, "expiry_state", "expiring_soon"),
        "grace": _count(views, "expiry_state", "grace"),
        "expired": _count(views, "expiry_state", "expired"),
        "dropped_to_free": _count(views, "expiry_state", "dropped_free"),
    }


# ---- reads ----------------------------------------------------------------

def _today(cur) -> date:
    cur.execute("SELECT CURRENT_DATE")
    return cur.fetchone()[0]


def _table_exists(cur, name: str) -> bool:
    cur.execute("SELECT to_regclass(%s) IS NOT NULL", (name,))
    return bool(cur.fetchone()[0])


def _settings(cur) -> Dict[str, Any]:
    cur.execute("SELECT currency, commission_base, expiry_mode, grace_days,"
                " expiring_soon_days FROM " + SETTINGS + " WHERE id = 1")
    return portal_db.rows(cur)[0]


def _client_rows(cur) -> List[Dict[str, Any]]:
    cur.execute(
        "SELECT ids.client_id,"
        " COALESCE(NULLIF(TRIM(p.profile->>'business_name'), ''),"
        " 'Client #' || ids.client_id) AS name,"
        " b.kind, b.plan_label, b.fee_amount, b.period_days, b.commission_percent,"
        " b.billed_from, b.expires_on, b.note"
        " FROM (SELECT client_id FROM " + PROFILES +
        " UNION SELECT client_id FROM " + CLIENTS + ") ids"
        " LEFT JOIN " + PROFILES + " p ON p.client_id = ids.client_id"
        " LEFT JOIN " + CLIENTS + " b ON b.client_id = ids.client_id"
        " ORDER BY ids.client_id"
    )
    return portal_db.rows(cur)


def _payment_out(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": int(row["id"]),
        "kind": row["kind"],
        "amount": _num(row["amount"]),
        "received_on": _iso(row["received_on"]),
        "method": row["method"] or "",
        "reference": row["reference"] or "",
        "note": row["note"] or "",
    }


def _recent_payments(cur) -> Dict[int, List[Dict[str, Any]]]:
    cur.execute(
        "SELECT id, client_id, kind, amount, received_on, method, reference, note"
        " FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY client_id"
        " ORDER BY received_on DESC, id DESC) AS rn FROM " + PAYMENTS + ") p"
        " WHERE rn <= " + str(RECENT_PAYMENTS) +
        " ORDER BY client_id, received_on DESC, id DESC"
    )
    grouped: Dict[int, List[Dict[str, Any]]] = {}
    for row in portal_db.rows(cur):
        grouped.setdefault(int(row["client_id"]), []).append(_payment_out(row))
    return grouped


def _paid_since(cur, client_id: int, since: date, today: date) -> Dict[str, Decimal]:
    cur.execute(
        "SELECT COALESCE(SUM(amount) FILTER (WHERE kind = 'fee'), 0) AS fee,"
        " COALESCE(SUM(amount) FILTER (WHERE kind = 'commission'), 0) AS commission"
        " FROM " + PAYMENTS + " WHERE client_id = %s AND received_on BETWEEN %s AND %s",
        (client_id, since, today),
    )
    row = portal_db.rows(cur)[0]
    return {"fee": Decimal(str(row["fee"])), "commission": Decimal(str(row["commission"]))}


def _sales(cur, client_id: int, base: str, since: date, today: date) -> Decimal:
    cur.execute(
        "SELECT COALESCE(SUM(total), 0) FROM " + LINKS +
        " WHERE client_id = %s AND " + _SALES_SQL[base],
        (client_id, since, today),
    )
    return Decimal(str(cur.fetchone()[0]))


def _client_view(cur, row: Dict[str, Any], settings: Dict[str, Any], today: date,
                 recent: List[Dict[str, Any]], links_ready: bool) -> Dict[str, Any]:
    client_id = int(row["client_id"])
    kind = row.get("kind") or "unset"
    expiry = _expiry(row.get("expires_on"), today, settings["expiry_mode"],
                     settings["grace_days"], settings["expiring_soon_days"])
    fee_due = fee_paid = sales = commission_due = commission_paid = Decimal("0")
    if row.get("kind") is not None:
        since = row["billed_from"]
        paid = _paid_since(cur, client_id, since, today)
        if kind == "subscription":
            fee_due = Decimal(str(row["fee_amount"])) * _periods_due(
                since, today, int(row["period_days"]))
            fee_paid = paid["fee"]
        if kind == "commission":
            if links_ready:
                sales = _sales(cur, client_id, settings["commission_base"], since, today)
            commission_due = (sales * Decimal(str(row["commission_percent"]))
                              / Decimal(100)).quantize(CENT, rounding=ROUND_HALF_UP)
            commission_paid = paid["commission"]
    fee_pending = max(Decimal("0"), fee_due - fee_paid)
    commission_pending = max(Decimal("0"), commission_due - commission_paid)
    payment_pending = {"subscription": fee_pending,
                       "commission": commission_pending}.get(kind, Decimal("0"))
    return {
        "client_id": client_id,
        "name": str(row.get("name") or ("Client #" + str(client_id))),
        "kind": kind,
        "plan_label": row.get("plan_label") or "",
        "fee_amount": _num(row.get("fee_amount")),
        "period_days": row.get("period_days"),
        "commission_percent": _num(row.get("commission_percent")),
        "billed_from": _iso(row.get("billed_from")),
        "expires_on": _iso(row.get("expires_on")),
        "note": row.get("note") or "",
        "days_left": expiry["days_left"],
        "expiry_state": expiry["state"],
        "dropped_to_free": expiry["dropped"],
        "fee_due": _num(fee_due),
        "fee_paid": _num(fee_paid),
        "fee_pending": _num(fee_pending),
        "sales_base": _num(sales),
        "commission_due": _num(commission_due),
        "commission_paid": _num(commission_paid),
        "commission_pending": _num(commission_pending),
        "payment_pending": _num(payment_pending),
        "payments": recent,
    }


def _overview(cur) -> Dict[str, Any]:
    today = _today(cur)
    settings = _settings(cur)
    links_ready = _table_exists(cur, LINKS)
    recent = _recent_payments(cur)
    views = [_client_view(cur, row, settings, today,
                          recent.get(int(row["client_id"]), []), links_ready)
             for row in _client_rows(cur)]
    return {
        "settings": settings,
        "today": today.isoformat(),
        "clients": views,
        "totals": _totals(views),
    }


# ---- writes ---------------------------------------------------------------

def _save_settings(cur, values: Dict[str, Any]) -> Dict[str, Any]:
    cur.execute(
        "UPDATE " + SETTINGS + " SET currency = %s, commission_base = %s,"
        " expiry_mode = %s, grace_days = %s, expiring_soon_days = %s,"
        " updated_at = NOW() WHERE id = 1",
        (values["currency"], values["commission_base"], values["expiry_mode"],
         values["grace_days"], values["expiring_soon_days"]),
    )
    return _settings(cur)


def _save_client(cur, client_id: int, v: Dict[str, Any]) -> None:
    cur.execute(
        "INSERT INTO " + CLIENTS + " (client_id, kind, plan_label, fee_amount,"
        " period_days, commission_percent, billed_from, expires_on, note, updated_at)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())"
        " ON CONFLICT (client_id) DO UPDATE SET kind = EXCLUDED.kind,"
        " plan_label = EXCLUDED.plan_label, fee_amount = EXCLUDED.fee_amount,"
        " period_days = EXCLUDED.period_days,"
        " commission_percent = EXCLUDED.commission_percent,"
        " billed_from = EXCLUDED.billed_from, expires_on = EXCLUDED.expires_on,"
        " note = EXCLUDED.note, updated_at = NOW()",
        (client_id, v["kind"], v["plan_label"], v["fee_amount"], v["period_days"],
         v["commission_percent"], v["billed_from"], v["expires_on"], v["note"]),
    )


def _add_payment(cur, client_id: int, v: Dict[str, Any]) -> Dict[str, Any]:
    if v["received_on"] > _today(cur):
        raise BadInput("received_on cannot be in the future.")
    cur.execute(
        "INSERT INTO " + PAYMENTS + " (client_id, kind, amount, received_on,"
        " method, reference, note) VALUES (%s, %s, %s, %s, %s, %s, %s)"
        " RETURNING id, kind, amount, received_on, method, reference, note",
        (client_id, v["kind"], v["amount"], v["received_on"], v["method"],
         v["reference"], v["note"]),
    )
    cols = [d[0] for d in cur.description]
    return _payment_out(dict(zip(cols, cur.fetchone())))


def _delete_payment(cur, payment_id: int) -> bool:
    cur.execute("DELETE FROM " + PAYMENTS + " WHERE id = %s", (payment_id,))
    return cur.rowcount > 0


# ---- routes ---------------------------------------------------------------

def _bad(message: str):
    return jsonify({"error": {"code": "invalid_input", "message": message}}), 400


def _unavailable(error: Exception, context: str):
    log.warning("billing %s failed: %s", context, error)
    return jsonify(portal_db.portal_unavailable(error, context)[0]), 503


@bp.get("")
def overview():
    try:
        portal_db.ensure_tables()
        return jsonify(_run(_overview)), 200
    except Exception as error:
        return _unavailable(error, "overview")


@bp.put("/settings")
def save_settings():
    try:
        values = _settings_input(_body())
    except BadInput as error:
        return _bad(str(error))
    try:
        return jsonify({"settings": _run(lambda cur: _save_settings(cur, values))}), 200
    except Exception as error:
        return _unavailable(error, "settings save")


@bp.put("/clients/<int:client_id>")
def save_client(client_id: int):
    if client_id <= 0:
        return _bad("client_id must be a positive number.")
    try:
        values = _client_input(_body())
    except BadInput as error:
        return _bad(str(error))
    try:
        _run(lambda cur: _save_client(cur, client_id, values))
        return jsonify({"ok": True}), 200
    except Exception as error:
        return _unavailable(error, "client save")


@bp.post("/clients/<int:client_id>/payments")
def record_payment(client_id: int):
    if client_id <= 0:
        return _bad("client_id must be a positive number.")
    try:
        values = _payment_input(_body())
        payment = _run(lambda cur: _add_payment(cur, client_id, values))
        return jsonify({"payment": payment}), 201
    except BadInput as error:
        return _bad(str(error))
    except Exception as error:
        return _unavailable(error, "payment save")


@bp.delete("/payments/<int:payment_id>")
def delete_payment(payment_id: int):
    try:
        removed = _run(lambda cur: _delete_payment(cur, payment_id))
    except Exception as error:
        return _unavailable(error, "payment delete")
    if not removed:
        return jsonify({"error": {"code": "not_found", "message": "Payment not found."}}), 404
    return jsonify({"ok": True}), 200


# ---- used by the client panel ----------------------------------------------

def plan_after_expiry(cur, client_id: int, plan: str) -> str:
    """The plan a client really gets after billing expiry (batch 261).

    Returns DROP_PLAN only when the saved expiry rule drops this client. Fail
    soft: a missing table, or any error, keeps the stored plan and rolls back to
    the savepoint so the rest of the request still works.
    """
    try:
        cur.execute("SAVEPOINT portal_billing_plan")
    except Exception:
        return plan
    try:
        cur.execute(_DROP_SQL, (client_id,))
        dropped = cur.fetchone() is not None
        cur.execute("RELEASE SAVEPOINT portal_billing_plan")
        return DROP_PLAN if dropped else plan
    except Exception as error:
        log.debug("billing plan check skipped client_id=%s: %s", client_id, error)
        try:
            cur.execute("ROLLBACK TO SAVEPOINT portal_billing_plan")
        except Exception:
            pass
        return plan
