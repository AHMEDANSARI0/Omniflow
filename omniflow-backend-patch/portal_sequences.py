"""Deterministic multi-step sequences for brand-new contacts.

§236 smart stops: before a follow-up goes out the engine checks what
happened since the customer joined (or was resumed into) the series:

* opted out              -> always stopped (compliance, not a switch);
* bought                 -> stopped when the series' stop_on_purchase is on:
                            a paid / advance-paid / shipped / delivered order
                            created after joining, a gateway payment after
                            joining, or a cash-on-delivery order confirmed
                            after joining;
* a person took over     -> stopped when stop_on_human is on: a teammate
                            replied from the inbox (a send command with a
                            requesting user) or the chat was handed off;
* another series wrote   -> a follow-up (not a series' first message) waits
                            until the workspace gap (gap_hours, default
                            OF_SEQ_GAP_HOURS) has passed since another series
                            messaged the same chat.

Stopped enrollments keep their reason (stop_reason) and can be resumed -
except opt-outs; resuming starts watching again from that moment. Signal
tables that do not exist yet (no checkout, no handoffs) simply never stop
a series. Switching a series off stops new enrolments only (people
already in it keep receiving it), and a series with a trigger keyword
enrols only customers who send that keyword - not every new contact.
"""

import csv
import io
import logging
import os
from typing import Any, Dict, List, Optional

from flask import Blueprint, Response, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db
import portal_growth
import portal_txn

bp = Blueprint("portal_sequences", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

SEQUENCES_TABLE = "portal_sequences"
STEPS_TABLE = "portal_sequence_steps"
ENROLLMENTS_TABLE = "portal_sequence_enrollments"
SETTINGS_TABLE = "portal_sequence_settings"
STEP_LOG_TABLE = "portal_sequence_step_log"
MAX_STEPS = 5
MAX_BODY = 1000
MAX_DELAY_HOURS = 168


def _env_hours(name: str, default: int) -> int:
    try:
        value = int(str(os.environ.get(name, "")).strip() or default)
    except ValueError:
        value = default
    return max(0, min(MAX_DELAY_HOURS, value))


#: Default spacing between follow-ups of DIFFERENT series to one chat
#: (workspace setting gap_hours overrides; 0 = off).
GAP_HOURS_DEFAULT = _env_hours("OF_SEQ_GAP_HOURS", 4)
STOP_REASONS = ("opted_out", "purchased", "human_took_over")
#: optional tables a stop signal reads (missing = that signal never fires)
SIGNAL_TABLES = {
    "handoffs": "portal_escalations",
    "links": "portal_checkout_links",
    "intents": "portal_payment_intents",
    "cod": "portal_cod_requests",
}
_SIGNAL_TABLES_SEEN: set = set()

_SEQ_DDL_READY = False


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


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    try:
        return value.isoformat()
    except AttributeError:
        return None


def _normalize_keyword(raw: Any) -> Optional[str]:
    """Lowercase, collapse spaces, cap at 32 chars; None when blank."""
    text = " ".join(str(raw or "").split()).lower()
    if not text:
        return None
    return text[:32]


def _gap_of(row: Dict[str, Any]) -> int:
    """The workspace gap between follow-ups of different series (hours)."""
    value = row.get("gap_hours") if row else None
    if value is None or isinstance(value, bool):
        return GAP_HOURS_DEFAULT
    try:
        return max(0, min(MAX_DELAY_HOURS, int(value)))
    except (TypeError, ValueError):
        return GAP_HOURS_DEFAULT


def _ensure_seq_tables(conn) -> None:
    global _SEQ_DDL_READY
    if _SEQ_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(SEQUENCES_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " name TEXT NOT NULL,"
            " enabled BOOLEAN NOT NULL DEFAULT FALSE,"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(STEPS_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " sequence_id BIGINT NOT NULL,"
            " step_no INT NOT NULL,"
            " delay_hours INT NOT NULL DEFAULT 0,"
            " body TEXT NOT NULL)"
        )
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(ENROLLMENTS_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " sequence_id BIGINT NOT NULL,"
            " conversation_id BIGINT NOT NULL,"
            " contact_id TEXT NOT NULL,"
            " contact_name TEXT,"
            " current_step INT NOT NULL DEFAULT 0,"
            " next_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " status TEXT NOT NULL DEFAULT 'active',"
            " enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " CONSTRAINT uq_sequence_enrollment"
            " UNIQUE (sequence_id, conversation_id))"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_due"
            " ON " + portal_db._q(ENROLLMENTS_TABLE) +
            " (client_id, status, next_at);"
            # §236 smart stops: why and when an enrollment stopped, and
            # from when stop signals count (resume restarts the watch)
            " ALTER TABLE " + portal_db._q(ENROLLMENTS_TABLE) +
            " ADD COLUMN IF NOT EXISTS stop_reason TEXT,"
            " ADD COLUMN IF NOT EXISTS stopped_at TIMESTAMPTZ,"
            " ADD COLUMN IF NOT EXISTS watch_from TIMESTAMPTZ"
        )
        cur.execute(
            "ALTER TABLE " + portal_db._q(SEQUENCES_TABLE) +
            " ADD COLUMN IF NOT EXISTS trigger_keyword TEXT"
        )
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(SETTINGS_TABLE) +
            " (client_id BIGINT PRIMARY KEY,"
            " quiet_enabled BOOLEAN NOT NULL DEFAULT FALSE,"
            " quiet_start INT NOT NULL DEFAULT 22,"
            " quiet_end INT NOT NULL DEFAULT 8,"
            " utc_offset INT NOT NULL DEFAULT 5);"
            " ALTER TABLE " + portal_db._q(SETTINGS_TABLE) +
            " ADD COLUMN IF NOT EXISTS gap_hours INT"
        )
        cur.execute(
            "ALTER TABLE " + portal_db._q(SEQUENCES_TABLE) +
            " ADD COLUMN IF NOT EXISTS pause_on_reply BOOLEAN NOT NULL DEFAULT TRUE,"
            " ADD COLUMN IF NOT EXISTS stop_on_purchase BOOLEAN NOT NULL DEFAULT TRUE,"
            " ADD COLUMN IF NOT EXISTS stop_on_human BOOLEAN NOT NULL DEFAULT TRUE"
        )
        cur.execute(
            "ALTER TABLE " + portal_db._q(STEPS_TABLE) +
            " ADD COLUMN IF NOT EXISTS only_if_idle_hours INT"
        )
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(STEP_LOG_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " sequence_id BIGINT NOT NULL,"
            " enrollment_id BIGINT NOT NULL,"
            " step_no INT NOT NULL,"
            " action TEXT NOT NULL,"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_sequence_step_log"
            " ON " + portal_db._q(STEP_LOG_TABLE) +
            " (client_id, sequence_id, step_no);"
            " CREATE INDEX IF NOT EXISTS idx_sequence_step_log_enrollment"
            " ON " + portal_db._q(STEP_LOG_TABLE) +
            " (enrollment_id, created_at)"
        )
    conn.commit()
    _SEQ_DDL_READY = True


def _parse_steps(raw: Any, client_id: int, sequence_id: int, cur) -> Optional[int]:
    """Validate and persist steps; returns count or None when invalid."""
    if not isinstance(raw, list) or not (1 <= len(raw) <= MAX_STEPS):
        return None
    cleaned = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            return None
        body = str(item.get("body") or "").strip()
        if not body or len(body) > MAX_BODY:
            return None
        try:
            delay = int(item.get("delay_hours", 0))
        except (TypeError, ValueError):
            return None
        if delay < 0 or delay > MAX_DELAY_HOURS:
            return None
        if index == 0 and delay < 0:
            return None
        idle_raw = item.get("only_if_idle_hours")
        if idle_raw is None or idle_raw == "":
            idle_value = None
        else:
            try:
                idle_value = int(idle_raw)
            except (TypeError, ValueError):
                return None
            if idle_value < 1 or idle_value > MAX_DELAY_HOURS:
                return None
        cleaned.append((index + 1, delay, body, idle_value))
    for step_no, delay, body, idle_value in cleaned:
        cur.execute(
            "INSERT INTO " + portal_db._q(STEPS_TABLE) +
            " (client_id, sequence_id, step_no, delay_hours, body,"
            " only_if_idle_hours)"
            " VALUES (%s, %s, %s, %s, %s, %s)",
            (client_id, sequence_id, step_no, delay, body, idle_value),
        )
    return len(cleaned)


def _steps_public(rows) -> list:
    return [
        {
            "step_no": int(row.get("step_no") or 0),
            "delay_hours": int(row.get("delay_hours") or 0),
            "body": row.get("body") or "",
            "only_if_idle_hours": (
                int(row["only_if_idle_hours"])
                if row.get("only_if_idle_hours") is not None else None
            ),
        }
        for row in rows
    ]


def _sequence_public(row: Dict[str, Any], steps, active_count: int,
                     completed_count: int = 0) -> dict:
    return {
        "id": row.get("id"),
        "name": row.get("name") or "",
        "enabled": row.get("enabled") is True,
        "created_at": _iso(row.get("created_at")),
        "steps": steps,
        "active_enrollments": active_count,
        "completed_enrollments": completed_count,
        "trigger_keyword": row.get("trigger_keyword") or None,
        "pause_on_reply": row.get("pause_on_reply") is not False,
        "stop_on_purchase": row.get("stop_on_purchase") is not False,
        "stop_on_human": row.get("stop_on_human") is not False,
    }


@bp.get("/sequences")
def list_sequences():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seq_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, name, enabled, created_at, trigger_keyword, pause_on_reply,"
                    " stop_on_purchase, stop_on_human FROM " + portal_db._q(SEQUENCES_TABLE) +
                    " WHERE client_id = %s ORDER BY id DESC LIMIT 20",
                    (principal["client_id"],),
                )
                sequences = portal_db.rows(cur)
                result = []
                for row in sequences:
                    cur.execute(
                        "SELECT step_no, delay_hours, body, only_if_idle_hours FROM " + portal_db._q(STEPS_TABLE) +
                        " WHERE client_id = %s AND sequence_id = %s ORDER BY step_no",
                        (principal["client_id"], row.get("id")),
                    )
                    steps = _steps_public(portal_db.rows(cur))
                    cur.execute(
                        "SELECT COUNT(*) AS total FROM " + portal_db._q(ENROLLMENTS_TABLE) +
                        " WHERE client_id = %s AND sequence_id = %s AND status = 'active'",
                        (principal["client_id"], row.get("id")),
                    )
                    counts = portal_db.rows(cur)
                    active_count = int(counts[0].get("total") or 0) if counts else 0
                    cur.execute(
                        "SELECT COUNT(*) AS total FROM " + portal_db._q(ENROLLMENTS_TABLE) +
                        " WHERE client_id = %s AND sequence_id = %s AND status = 'completed'",
                        (principal["client_id"], row.get("id")),
                    )
                    dones = portal_db.rows(cur)
                    completed_count = int(dones[0].get("total") or 0) if dones else 0
                    result.append(_sequence_public(row, steps, active_count,
                                                   completed_count))
        finally:
            conn.close()
    except Exception as error:
        logger.warning("sequences read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "sequences read")[0]), 503
    return jsonify({"sequences": result}), 200


@bp.get("/sequences/settings")
def get_sequence_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seq_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT quiet_enabled, quiet_start, quiet_end, utc_offset,"
                    " gap_hours FROM " +
                    portal_db._q(SETTINGS_TABLE) +
                    " WHERE client_id = %s",
                    (principal["client_id"],),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "settings read")[0]), 503
    row = rows[0] if rows else {}
    return jsonify({
        "quiet_enabled": row.get("quiet_enabled") is True,
        "quiet_start": int(row.get("quiet_start") if row.get("quiet_start") is not None else 22),
        "quiet_end": int(row.get("quiet_end") if row.get("quiet_end") is not None else 8),
        "utc_offset": int(row.get("utc_offset") if row.get("utc_offset") is not None else 5),
        "gap_hours": _gap_of(row),
        "gap_hours_default": GAP_HOURS_DEFAULT,
    }), 200


@bp.put("/sequences/settings")
def update_sequence_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    enabled = payload.get("quiet_enabled")
    if not isinstance(enabled, bool):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "quiet_enabled must be true or false."}}), 400

    def _hour(value):
        if isinstance(value, bool) or not isinstance(value, int):
            return None
        return value if 0 <= value <= 23 else None

    start = _hour(payload.get("quiet_start"))
    end = _hour(payload.get("quiet_end"))
    if start is None or end is None:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Hours must be integers from 0 to 23."}}), 400
    offset = payload.get("utc_offset")
    if isinstance(offset, bool) or not isinstance(offset, int) or not -12 <= offset <= 14:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "UTC offset must be between -12 and +14."}}), 400
    has_gap = "gap_hours" in payload
    gap = payload.get("gap_hours")
    if has_gap and gap is not None and (
            isinstance(gap, bool) or not isinstance(gap, int)
            or not 0 <= gap <= MAX_DELAY_HOURS):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "gap_hours must be 0 to %d (or null for the default)."
                                  % MAX_DELAY_HOURS}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seq_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(SETTINGS_TABLE) +
                    " (client_id, quiet_enabled, quiet_start, quiet_end, utc_offset)"
                    " VALUES (%s, %s, %s, %s, %s)"
                    " ON CONFLICT (client_id) DO UPDATE SET"
                    " quiet_enabled = %s, quiet_start = %s, quiet_end = %s,"
                    " utc_offset = %s",
                    (principal["client_id"], enabled, start, end, offset,
                     enabled, start, end, offset),
                )
                if has_gap:
                    cur.execute(
                        "UPDATE " + portal_db._q(SETTINGS_TABLE) +
                        " SET gap_hours = %s WHERE client_id = %s",
                        (gap, principal["client_id"]),
                    )
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "sequence.quiet_updated",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Night guard %s (%02d:00-%02d:00 UTC%+d)." % (
                        "on" if enabled else "off", start, end, offset),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "settings update")[0]), 503
    return jsonify({"ok": True}), 200


@bp.post("/sequences")
def create_sequence():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name") or "").strip()[:120]
    if not name:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "A name is required."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seq_tables(conn)
            with conn.cursor() as cur:
                keyword = _normalize_keyword(payload.get("trigger_keyword"))
                cur.execute(
                    "INSERT INTO " + portal_db._q(SEQUENCES_TABLE) +
                    " (client_id, name, enabled, trigger_keyword)"
                    " VALUES (%s, %s, FALSE, %s)"
                    " RETURNING id, name, enabled, created_at, trigger_keyword",
                    (principal["client_id"], name, keyword),
                )
                rows = portal_db.rows(cur)
                created = rows[0] if rows else {}
                sequence_id = int(created.get("id") or 0)
                count = _parse_steps(payload.get("steps"), principal["client_id"],
                                     sequence_id, cur)
                if count is None:
                    conn.rollback()
                    return jsonify({"error": {"code": "bad_request",
                                              "message": "Steps: 1 to 5, each with text and a 0-168h delay."}}), 400
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "sequence.created",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Sequence '" + name + "' with " + str(count) + " steps.",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "sequence create")[0]), 503
    return jsonify({"ok": True,
                    "sequence": _sequence_public(created, [], 0)}), 200


@bp.put("/sequences/<int:sequence_id>")
def update_sequence(sequence_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    changes = []
    params: list = []
    if "name" in payload:
        name = str(payload.get("name") or "").strip()[:120]
        if not name:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Name cannot be empty."}}), 400
        changes.append("name = %s")
        params.append(name)
    if "trigger_keyword" in payload:
        changes.append("trigger_keyword = %s")
        params.append(_normalize_keyword(payload.get("trigger_keyword")))
    if "pause_on_reply" in payload:
        if not isinstance(payload.get("pause_on_reply"), bool):
            return jsonify({"error": {"code": "bad_request",
                                      "message": "pause_on_reply must be true or false."}}), 400
        changes.append("pause_on_reply = %s")
        params.append(payload.get("pause_on_reply"))
    if "enabled" in payload:
        if not isinstance(payload.get("enabled"), bool):
            return jsonify({"error": {"code": "bad_request",
                                      "message": "enabled must be true or false."}}), 400
        changes.append("enabled = %s")
        params.append(payload.get("enabled"))
    for flag in ("stop_on_purchase", "stop_on_human"):
        if flag in payload:
            if not isinstance(payload.get(flag), bool):
                return jsonify({"error": {"code": "bad_request",
                                          "message": flag + " must be true or false."}}), 400
            changes.append(flag + " = %s")
            params.append(payload.get(flag))
    if not changes:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Nothing to update."}}), 400
    params.extend([sequence_id, principal["client_id"]])
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seq_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(SEQUENCES_TABLE) +
                    " SET " + ", ".join(changes) +
                    " WHERE id = %s AND client_id = %s"
                    " RETURNING id",
                    tuple(params),
                )
                rows = portal_db.rows(cur)
            # §236: this update was never committed - switching a series on
            # or off, renaming it or changing its trigger did not stick
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "sequence update")[0]), 503
    if not rows:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Sequence not found."}}), 404
    return jsonify({"ok": True}), 200


@bp.put("/sequences/<int:sequence_id>/steps")
def replace_sequence_steps(sequence_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seq_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id FROM " + portal_db._q(SEQUENCES_TABLE) +
                    " WHERE id = %s AND client_id = %s",
                    (sequence_id, principal["client_id"]),
                )
                found = portal_db.rows(cur)
                if not found:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Sequence not found."}}), 404
                cur.execute(
                    "DELETE FROM " + portal_db._q(STEPS_TABLE) +
                    " WHERE client_id = %s AND sequence_id = %s",
                    (principal["client_id"], sequence_id),
                )
                count = _parse_steps(payload.get("steps"), principal["client_id"],
                                     sequence_id, cur)
                if count is None:
                    conn.rollback()
                    return jsonify({"error": {"code": "bad_request",
                                              "message": "Steps: 1 to 5, each with text and a 0-168h delay."}}), 400
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "sequence.steps_updated",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Sequence #%d now has %d step(s)." % (sequence_id, count),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "sequence steps update")[0]), 503
    return jsonify({"ok": True}), 200


@bp.delete("/sequences/<int:sequence_id>")
def delete_sequence(sequence_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seq_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM " + portal_db._q(ENROLLMENTS_TABLE) +
                    " WHERE client_id = %s AND sequence_id = %s",
                    (principal["client_id"], sequence_id),
                )
                cur.execute(
                    "DELETE FROM " + portal_db._q(STEPS_TABLE) +
                    " WHERE client_id = %s AND sequence_id = %s",
                    (principal["client_id"], sequence_id),
                )
                cur.execute(
                    "DELETE FROM " + portal_db._q(SEQUENCES_TABLE) +
                    " WHERE id = %s AND client_id = %s RETURNING id",
                    (sequence_id, principal["client_id"]),
                )
                rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "sequence delete")[0]), 503
    if not rows:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Sequence not found."}}), 404
    return jsonify({"ok": True}), 200


@bp.get("/sequences/<int:sequence_id>/enrollments")
def list_enrollments(sequence_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seq_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM " + portal_db._q(SEQUENCES_TABLE) +
                    " WHERE id = %s AND client_id = %s",
                    (sequence_id, principal["client_id"]),
                )
                if not portal_db.rows(cur):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Sequence not found."}}), 404
                cur.execute(
                    "SELECT id, contact_name, contact_id, current_step, status,"
                    " next_at, enrolled_at, stop_reason, stopped_at FROM "
                    + portal_db._q(ENROLLMENTS_TABLE) +
                    " WHERE client_id = %s AND sequence_id = %s"
                    " ORDER BY id DESC LIMIT 20",
                    (principal["client_id"], sequence_id),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "enrollments read")[0]), 503
    return jsonify({"enrollments": [
        {
            "id": row.get("id"),
            "contact_name": row.get("contact_name"),
            "contact_id": row.get("contact_id"),
            "current_step": int(row.get("current_step") or 0),
            "status": row.get("status") or "active",
            "next_at": _iso(row.get("next_at")),
            "enrolled_at": _iso(row.get("enrolled_at")),
            "stop_reason": row.get("stop_reason") or None,
            "stopped_at": _iso(row.get("stopped_at")),
        }
        for row in found
    ]}), 200


@bp.get("/sequences/<int:sequence_id>/enrollments/export")
def export_sequence_enrollments(sequence_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seq_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, name FROM " + portal_db._q(SEQUENCES_TABLE) +
                    " WHERE id = %s AND client_id = %s",
                    (sequence_id, principal["client_id"]),
                )
                if not portal_db.rows(cur):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Sequence not found."}}), 404
                cur.execute(
                    "SELECT contact_name, contact_id, status, current_step, enrolled_at,"
                    " stop_reason FROM " + portal_db._q(ENROLLMENTS_TABLE) +
                    " WHERE client_id = %s AND sequence_id = %s"
                    " ORDER BY id DESC LIMIT 2000",
                    (principal["client_id"], sequence_id),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "enrollments export")[0]), 503
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["contact_name", "contact_id", "status", "current_step",
                     "enrolled_at", "stop_reason"])
    for row in found:
        writer.writerow([
            row.get("contact_name") or "",
            row.get("contact_id") or "",
            row.get("status") or "active",
            int(row.get("current_step") or 0),
            _iso(row.get("enrolled_at")) or "",
            row.get("stop_reason") or "",
        ])
    return Response(
        buffer.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition":
                 "attachment; filename=sequence-%d-enrollments.csv" % sequence_id},
    )


@bp.get("/sequences/<int:sequence_id>/stats")
def sequence_stats(sequence_id: int):
    """Per-step sent/skipped funnel for one sequence."""
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seq_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM " + portal_db._q(SEQUENCES_TABLE) +
                    " WHERE id = %s AND client_id = %s",
                    (sequence_id, principal["client_id"]),
                )
                if not portal_db.rows(cur):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Sequence not found."}}), 404
                cur.execute(
                    "SELECT step_no,"
                    " COUNT(*) FILTER (WHERE action = 'sent') AS sent,"
                    " COUNT(*) FILTER (WHERE action = 'skipped') AS skipped,"
                    " COUNT(*) FILTER (WHERE action = 'stopped') AS stopped"
                    " FROM " + portal_db._q(STEP_LOG_TABLE) +
                    " WHERE client_id = %s AND sequence_id = %s"
                    " GROUP BY step_no ORDER BY step_no",
                    (principal["client_id"], sequence_id),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "sequence stats")[0]), 503
    return jsonify({"steps": [
        {
            "step_no": int(row.get("step_no") or 0),
            "sent": int(row.get("sent") or 0),
            "skipped": int(row.get("skipped") or 0),
            "stopped": int(row.get("stopped") or 0),
        }
        for row in rows
    ]}), 200


@bp.post("/sequences/<int:sequence_id>/enrollments/<int:enrollment_id>/pause")
def pause_enrollment(sequence_id: int, enrollment_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seq_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(ENROLLMENTS_TABLE) +
                    " SET status = 'paused'"
                    " WHERE id = %s AND client_id = %s AND sequence_id = %s"
                    " AND status = 'active'"
                    " RETURNING contact_name",
                    (enrollment_id, principal["client_id"], sequence_id),
                )
                rows = portal_db.rows(cur)
                if not rows:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Enrollment not found or not active."}}), 404
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "sequence.enrollment_paused",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Enrollment for %s paused." % (
                        rows[0].get("contact_name") or "customer"),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "enrollment pause")[0]), 503
    return jsonify({"ok": True}), 200


@bp.post("/sequences/<int:sequence_id>/enrollments/<int:enrollment_id>/resume")
def resume_enrollment(sequence_id: int, enrollment_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seq_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(ENROLLMENTS_TABLE) +
                    " SET status = 'active', stop_reason = NULL,"
                    " stopped_at = NULL,"
                    " watch_from = NOW()"
                    " WHERE id = %s AND client_id = %s AND sequence_id = %s"
                    " AND (status = 'paused' OR (status = 'stopped'"
                    " AND COALESCE(stop_reason, '') <> 'opted_out'))"
                    " RETURNING contact_name",
                    (enrollment_id, principal["client_id"], sequence_id),
                )
                rows = portal_db.rows(cur)
                if not rows:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Enrollment not found, not paused or stopped, or the customer opted out."}}), 404
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "sequence.enrollment_resumed",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Enrollment for %s resumed." % (
                        rows[0].get("contact_name") or "customer"),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "enrollment resume")[0]), 503
    return jsonify({"ok": True}), 200


@bp.post("/sequences/<int:sequence_id>/enrollments/pause-all")
def pause_all_enrollments(sequence_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seq_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(ENROLLMENTS_TABLE) +
                    " SET status = 'paused'"
                    " WHERE client_id = %s AND sequence_id = %s"
                    " AND status = 'active'"
                    " RETURNING id",
                    (principal["client_id"], sequence_id),
                )
                rows = portal_db.rows(cur)
                if rows:
                    portal_db.log_action(
                        cur,
                        principal["client_id"],
                        "sequence.enrollments_paused",
                        "customer_user",
                        principal.get("user_id"),
                        None,
                        "Paused %d enrollment(s)." % len(rows),
                    )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "enrollments pause")[0]), 503
    return jsonify({"ok": True, "paused": len(rows)}), 200


@bp.post("/sequences/<int:sequence_id>/enrollments/resume-all")
def resume_all_enrollments(sequence_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seq_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(ENROLLMENTS_TABLE) +
                    " SET status = 'active', watch_from = NOW()"
                    " WHERE client_id = %s AND sequence_id = %s"
                    " AND status = 'paused'"
                    " RETURNING id",
                    (principal["client_id"], sequence_id),
                )
                rows = portal_db.rows(cur)
                if rows:
                    portal_db.log_action(
                        cur,
                        principal["client_id"],
                        "sequence.enrollments_resumed",
                        "customer_user",
                        principal.get("user_id"),
                        None,
                        "Resumed %d enrollment(s)." % len(rows),
                    )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "enrollments resume")[0]), 503
    return jsonify({"ok": True, "resumed": len(rows)}), 200


def _normalize_contact(value: Any) -> str:
    """Normalize a pasted phone number or id to the WhatsApp jid form."""
    text = str(value or "").strip()
    for char in (" ", "-", "(", ")"):
        text = text.replace(char, "")
    if not text:
        return ""
    if "@" not in text:
        text = text.lstrip("+") + "@c.us"
    return text


@bp.post("/sequences/<int:sequence_id>/enrollments")
def enroll_contacts(sequence_id: int):
    """Manually enroll pasted contacts into a sequence."""
    principal, error = _principal_or_error()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    raw = payload.get("contacts")
    if not isinstance(raw, list):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "contacts must be a list."}}), 400
    seen: list = []
    for item in raw[:50]:
        contact = _normalize_contact(item)
        if contact and contact not in seen:
            seen.append(contact)
    if not seen:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "No valid contacts."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seq_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM " + portal_db._q(SEQUENCES_TABLE) +
                    " WHERE id = %s AND client_id = %s",
                    (sequence_id, principal["client_id"]),
                )
                if not portal_db.rows(cur):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Sequence not found."}}), 404
                cur.execute(
                    "INSERT INTO " + portal_db._q(ENROLLMENTS_TABLE) +
                    " (client_id, sequence_id, conversation_id, contact_id,"
                    " contact_name, current_step, next_at)"
                    " SELECT %s, %s, c.id, c.contact_id, c.contact_name, 0,"
                    " NOW() + make_interval(hours => COALESCE(MIN(st.delay_hours), 0))"
                    " FROM " + portal_db._q(portal_db.CONV_TABLE) + " c"
                    " LEFT JOIN " + portal_db._q(STEPS_TABLE) +
                    " st ON st.sequence_id = %s AND st.step_no = 1"
                    " WHERE c.client_id = %s AND c.contact_id = ANY(%s)"
                    " AND NOT EXISTS (SELECT 1 FROM " + portal_db._q(ENROLLMENTS_TABLE) +
                    " e WHERE e.sequence_id = %s AND e.conversation_id = c.id)"
                    " GROUP BY c.id, c.contact_id, c.contact_name"
                    " RETURNING contact_id",
                    (principal["client_id"], sequence_id, sequence_id,
                     principal["client_id"], seen, sequence_id),
                )
                enrolled_rows = portal_db.rows(cur)
                enrolled_ids = {row.get("contact_id") for row in enrolled_rows}
                skipped = [c for c in seen if c not in enrolled_ids]
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "sequence.enrolled_manually",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Enrolled " + str(len(enrolled_rows)) + " contact(s) into"
                    " sequence " + str(sequence_id) + ".",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "sequence enroll")[0]), 503
    return jsonify({"enrolled": len(enrolled_rows), "skipped": skipped}), 200


@bp.delete("/sequences/<int:sequence_id>/enrollments/<int:enrollment_id>")
def cancel_enrollment(sequence_id: int, enrollment_id: int):
    """Stop an active enrollment."""
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seq_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM " + portal_db._q(SEQUENCES_TABLE) +
                    " WHERE id = %s AND client_id = %s",
                    (sequence_id, principal["client_id"]),
                )
                if not portal_db.rows(cur):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Sequence not found."}}), 404
                cur.execute(
                    "UPDATE " + portal_db._q(ENROLLMENTS_TABLE) +
                    " SET status = 'cancelled'"
                    " WHERE id = %s AND sequence_id = %s AND client_id = %s"
                    " AND status = 'active' RETURNING id",
                    (enrollment_id, sequence_id, principal["client_id"]),
                )
                if not portal_db.rows(cur):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Enrollment not found or not active."}}), 404
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "sequence.enrollment_cancelled",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Cancelled enrollment " + str(enrollment_id) + ".",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "enrollment cancel")[0]), 503
    return jsonify({"ok": True}), 200

def maybe_enroll_new_contact(client_id, conversation_id, contact_id,
                             contact_name, conn) -> None:
    """Ingest hook: enroll contacts whose conversation has one message."""
    portal_db.ensure_tables()
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO " + portal_db._q(ENROLLMENTS_TABLE) +
            " (client_id, sequence_id, conversation_id, contact_id, contact_name,"
            " current_step, next_at)"
            " SELECT %s, s.id, %s, %s, %s, 0,"
            " NOW() + make_interval(hours => COALESCE(MIN(st.delay_hours), 0))"
            " FROM " + portal_db._q(SEQUENCES_TABLE) + " s"
            " LEFT JOIN " + portal_db._q(STEPS_TABLE) +
            " st ON st.sequence_id = s.id AND st.step_no = 1"
            " WHERE s.client_id = %s AND s.enabled IS TRUE"
            # §236: a keyword series is for customers who send its keyword,
            # not for every new contact
            " AND COALESCE(s.trigger_keyword, '') = ''"
            " AND NOT EXISTS (SELECT 1 FROM " + portal_db._q(ENROLLMENTS_TABLE) +
            " e WHERE e.sequence_id = s.id AND e.conversation_id = %s)"
            " AND (SELECT COUNT(*) FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " m WHERE m.conversation_id = %s) <= 1"
            " GROUP BY s.id"
            " RETURNING id",
            (client_id, conversation_id, str(contact_id or ""),
             str(contact_name or ""), client_id, conversation_id, conversation_id),
        )
        enrolled = portal_db.rows(cur)
        if enrolled:
            portal_db.log_action(
                cur,
                client_id,
                "sequence.enrolled",
                "automation",
                None,
                conversation_id,
                "Enrolled " + str(len(enrolled)) + " sequence(s).",
            )


def maybe_enroll_keyword(client_id, conversation_id, contact_id,
                         contact_name, body, conn) -> None:
    """Ingest hook: enroll a contact when their message matches a trigger."""
    keyword = _normalize_keyword(body)
    if not keyword:
        return
    portal_db.ensure_tables()
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO " + portal_db._q(ENROLLMENTS_TABLE) +
            " (client_id, sequence_id, conversation_id, contact_id,"
            " contact_name, current_step, next_at)"
            " SELECT %s, s.id, %s, %s, %s, 0,"
            " NOW() + make_interval(hours => COALESCE(MIN(st.delay_hours), 0))"
            " FROM " + portal_db._q(SEQUENCES_TABLE) + " s"
            " LEFT JOIN " + portal_db._q(STEPS_TABLE) +
            " st ON st.sequence_id = s.id AND st.step_no = 1"
            " WHERE s.client_id = %s AND s.enabled IS TRUE"
            " AND s.trigger_keyword = %s"
            " AND NOT EXISTS (SELECT 1 FROM " + portal_db._q(ENROLLMENTS_TABLE) +
            " e WHERE e.sequence_id = s.id AND e.conversation_id = %s)"
            " GROUP BY s.id"
            " RETURNING id",
            (client_id, conversation_id, str(contact_id or ""),
             str(contact_name or ""), client_id, keyword, conversation_id),
        )
        enrolled = portal_db.rows(cur)
        if enrolled:
            portal_db.log_action(
                cur,
                client_id,
                "sequence.enrolled_keyword",
                "automation",
                None,
                conversation_id,
                "Keyword '" + keyword + "' enrolled " + str(len(enrolled))
                + " sequence(s).",
            )


def maybe_auto_pause_replies(client_id: int, conversation_id: int, conn) -> int:
    """Pause a conversation's running series when the customer replies.

    Enrollments younger than 2 minutes are spared so the message that just
    enrolled (keyword trigger) never pauses its own series.
    """
    try:
        portal_db.ensure_tables()
        _ensure_seq_tables(conn)
    except Exception:
        return 0
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE " + portal_db._q(ENROLLMENTS_TABLE) + " e"
                " SET status = 'paused'"
                " FROM " + portal_db._q(SEQUENCES_TABLE) + " s"
                " WHERE e.sequence_id = s.id"
                " AND e.client_id = %s AND e.conversation_id = %s"
                " AND e.status = 'active'"
                " AND e.enrolled_at < NOW() - interval '2 minutes'"
                " AND s.enabled IS TRUE AND s.pause_on_reply IS TRUE"
                " RETURNING e.id",
                (client_id, conversation_id),
            )
            rows = portal_db.rows(cur)
            if not rows:
                return 0
            portal_db.log_action(
                cur,
                client_id,
                "sequence.auto_paused",
                "system",
                None,
                conversation_id,
                "Auto-paused %d series after the customer replied." % len(rows),
            )
        conn.commit()
        return len(rows)
    except Exception:
        return 0


def _signal_tables(cur) -> set:
    """Optional stop-signal tables that exist (re-probed until all exist)."""
    if len(_SIGNAL_TABLES_SEEN) == len(SIGNAL_TABLES):
        return set(_SIGNAL_TABLES_SEEN)
    keys = list(SIGNAL_TABLES)
    cur.execute(
        "SELECT " + ", ".join(
            "to_regclass(%s) IS NOT NULL AS " + key for key in keys),
        tuple(SIGNAL_TABLES[key] for key in keys),
    )
    row = (portal_db.rows(cur) or [{}])[0]
    found = {key for key in keys if row.get(key) is True}
    _SIGNAL_TABLES_SEEN.update(found)
    return found


def _stop_signals(cur, client_id: int, ids: List[int], gap: int) -> Dict[int, Dict[str, Any]]:
    """One query for every due enrollment: what happened since it joined.

    Returns {enrollment_id: {opted_out, purchased, human, other_sent_at}}.
    """
    tables = _signal_tables(cur)
    watch = "COALESCE(e.watch_from, e.enrolled_at)"
    q = portal_db._q
    handoff = (
        "EXISTS (SELECT 1 FROM " + q(SIGNAL_TABLES["handoffs"]) + " x"
        " WHERE x.client_id = e.client_id AND x.conversation_id = e.conversation_id"
        " AND x.created_at > " + watch + ")"
        if "handoffs" in tables else "FALSE")
    buys = []
    if "links" in tables:
        buys.append(
            "EXISTS (SELECT 1 FROM " + q(SIGNAL_TABLES["links"]) + " l"
            " WHERE l.client_id = e.client_id AND l.contact_id = e.contact_id"
            " AND l.created_at > " + watch +
            " AND (l.status IN ('paid', 'shipped', 'delivered')"
            " OR COALESCE(l.paid_amount, 0) > 0))")
        if "intents" in tables:
            buys.append(
                "EXISTS (SELECT 1 FROM " + q(SIGNAL_TABLES["intents"]) + " pi"
                " JOIN " + q(SIGNAL_TABLES["links"]) + " pl"
                " ON pl.id = pi.link_id AND pl.client_id = pi.client_id"
                " WHERE pi.client_id = e.client_id AND pl.contact_id = e.contact_id"
                " AND pi.status = 'paid' AND pi.updated_at > " + watch + ")")
    if "cod" in tables:
        buys.append(
            "EXISTS (SELECT 1 FROM " + q(SIGNAL_TABLES["cod"]) + " r"
            " WHERE r.client_id = e.client_id AND r.status = 'confirmed'"
            " AND (r.conversation_id = e.conversation_id"
            " OR r.contact_id = e.contact_id)"
            " AND r.answered_at > " + watch + ")")
    params: List[Any] = []
    if gap > 0:
        other = (
            "(SELECT MAX(lg.created_at) FROM " + q(STEP_LOG_TABLE) + " lg"
            " JOIN " + q(ENROLLMENTS_TABLE) + " o2 ON o2.id = lg.enrollment_id"
            " WHERE o2.client_id = e.client_id"
            " AND o2.conversation_id = e.conversation_id"
            " AND o2.sequence_id <> e.sequence_id AND lg.action = 'sent'"
            " AND lg.created_at > NOW() - make_interval(hours => %s))")
        params.append(int(gap))
    else:
        other = "NULL"
    cur.execute(
        "SELECT e.id,"
        " EXISTS (SELECT 1 FROM " + q("portal_optouts") + " o"
        " WHERE o.client_id = e.client_id AND o.contact_id = e.contact_id)"
        " AS opted_out,"
        " (" + (" OR ".join(buys) if buys else "FALSE") + ") AS purchased,"
        " (EXISTS (SELECT 1 FROM " + q(portal_db.CMD_TABLE) + " c"
        " WHERE c.client_id = e.client_id"
        " AND c.action IN ('send_message', 'send_media')"
        " AND c.requested_by IS NOT NULL AND c.created_at > " + watch +
        " AND (c.payload->>'conversation_id' = e.conversation_id::text"
        " OR c.payload->>'external_user_id' = e.contact_id))"
        " OR " + handoff + ") AS human,"
        " " + other + " AS other_sent_at"
        " FROM " + q(ENROLLMENTS_TABLE) + " e"
        " WHERE e.client_id = %s AND e.id = ANY(%s)",
        tuple(params) + (client_id, list(ids)),
    )
    return {int(row["id"]): row for row in portal_db.rows(cur)}


def stop_reason_for(row: Dict[str, Any], signal: Optional[Dict[str, Any]]) -> Optional[str]:
    """Why a due enrollment must stop now (None = keep going)."""
    if not signal:
        return None
    if signal.get("opted_out") is True:
        return "opted_out"
    if signal.get("purchased") is True and row.get("stop_on_purchase") is not False:
        return "purchased"
    if signal.get("human") is True and row.get("stop_on_human") is not False:
        return "human_took_over"
    return None


STOP_NOTES = {
    "opted_out": "the customer opted out",
    "purchased": "the customer bought",
    "human_took_over": "a teammate took over the chat",
}


def deliver_due_sequence_steps(cur, client_id: int, conn) -> int:
    """Send due steps for active enrollments (max 5 per poll), after the
    §236 smart-stop and spacing checks."""
    try:
        portal_db.ensure_tables()
        _ensure_seq_tables(conn)
    except Exception:
        return 0
    try:
        # psycopg2 formats this SQL with params: a literal modulo is "%%"
        # (a bare "% 24" raised IndexError, and NOT EXISTS was never
        # closed, so no series step was ever sent - §232 fix)
        cur.execute(
            "SELECT e.id, e.sequence_id, e.current_step, e.conversation_id,"
            " e.contact_id, e.contact_name, s.stop_on_purchase,"
            " s.stop_on_human, g.gap_hours"
            " FROM " + portal_db._q(ENROLLMENTS_TABLE) + " e"
            # §236 stop flags; "off" only stops NEW enrolments (the UI's
            # "enrolling"), people already in a series keep receiving it
            " LEFT JOIN " + portal_db._q(SEQUENCES_TABLE) + " s"
            " ON s.id = e.sequence_id AND s.client_id = e.client_id"
            " LEFT JOIN " + portal_db._q(SETTINGS_TABLE) + " g"
            " ON g.client_id = e.client_id"
            " WHERE e.client_id = %s AND e.status = 'active'"
            " AND e.next_at <= NOW()"
            " AND NOT EXISTS ("
            " SELECT 1 FROM " + portal_db._q(SETTINGS_TABLE) + " q"
            " WHERE q.client_id = %s AND q.quiet_enabled IS TRUE"
            " AND ((q.quiet_start < q.quiet_end"
            " AND (EXTRACT(HOUR FROM NOW() AT TIME ZONE 'UTC')::int + q.utc_offset)"
            " %% 24 >= q.quiet_start"
            " AND (EXTRACT(HOUR FROM NOW() AT TIME ZONE 'UTC')::int + q.utc_offset)"
            " %% 24 < q.quiet_end)"
            " OR (q.quiet_start > q.quiet_end"
            " AND ((EXTRACT(HOUR FROM NOW() AT TIME ZONE 'UTC')::int + q.utc_offset)"
            " %% 24 >= q.quiet_start"
            " OR (EXTRACT(HOUR FROM NOW() AT TIME ZONE 'UTC')::int + q.utc_offset)"
            " %% 24 < q.quiet_end))))"
            " ORDER BY e.next_at LIMIT 5",
            (client_id, client_id),
        )
        due = portal_db.rows(cur)
        if not due:
            return 0
        gap = _gap_of(due[0])
        try:
            # a signal table with an older shape must not stop delivery:
            # the check fails soft (nothing stops) in its own savepoint
            with portal_txn.savepoint(cur, conn, "of_seq_stops"):
                signals = _stop_signals(
                    cur, client_id, [int(row.get("id") or 0) for row in due], gap)
        except Exception as error:
            logger.warning("sequence stop check failed: %s", error)
            signals = {}
        sent = 0
        changed = 0
        for row in due:
            current_step = int(row.get("current_step") or 0)
            signal = signals.get(int(row.get("id") or 0))
            reason = stop_reason_for(row, signal)
            if reason:
                cur.execute(
                    "UPDATE " + portal_db._q(ENROLLMENTS_TABLE) +
                    " SET status = 'stopped', stop_reason = %s, stopped_at = NOW()"
                    " WHERE id = %s AND client_id = %s AND status = 'active'",
                    (reason, row.get("id"), client_id),
                )
                cur.execute(
                    "INSERT INTO " + portal_db._q(STEP_LOG_TABLE) +
                    " (client_id, sequence_id, enrollment_id, step_no, action)"
                    " VALUES (%s, %s, %s, %s, 'stopped')",
                    (client_id, row.get("sequence_id"), row.get("id"),
                     current_step + 1),
                )
                portal_db.log_action(
                    cur, client_id, "sequence.stopped", "automation", None,
                    row.get("conversation_id"),
                    ("Series stopped for %s: %s." % (
                        row.get("contact_name") or "customer",
                        STOP_NOTES[reason]))[:200],
                )
                changed += 1
                continue
            other_sent = (signal or {}).get("other_sent_at")
            if current_step > 0 and gap > 0 and other_sent is not None:
                # a follow-up right after another series wrote to this chat
                # waits until the gap has passed (never dropped)
                cur.execute(
                    "UPDATE " + portal_db._q(ENROLLMENTS_TABLE) +
                    " SET next_at = %s + make_interval(hours => %s)"
                    " WHERE id = %s AND client_id = %s",
                    (other_sent, gap, row.get("id"), client_id),
                )
                changed += 1
                continue
            cur.execute(
                "SELECT step_no, delay_hours, body, only_if_idle_hours FROM " + portal_db._q(STEPS_TABLE) +
                " WHERE client_id = %s AND sequence_id = %s AND step_no > %s"
                " ORDER BY step_no LIMIT 2",
                (client_id, row.get("sequence_id"), current_step),
            )
            upcoming = portal_db.rows(cur)
            if not upcoming:
                cur.execute(
                    "UPDATE " + portal_db._q(ENROLLMENTS_TABLE) +
                    " SET status = 'completed' WHERE id = %s",
                    (row.get("id"),),
                )
                changed += 1
                continue
            step = upcoming[0]
            idle = step.get("only_if_idle_hours")
            skip = False
            if idle is not None:
                cur.execute(
                    "SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
                    " WHERE client_id = %s AND conversation_id = %s"
                    " AND direction = 'in'"
                    " AND created_at > NOW() - make_interval(hours => %s)"
                    " LIMIT 1",
                    (client_id, row.get("conversation_id"), int(idle)),
                )
                skip = bool(portal_db.rows(cur))
            if not skip:
                display = str(row.get("contact_name") or "").strip()
                body = str(step.get("body") or "").replace(
                    "{name}", (display.split(" ")[0] if display else "there")
                )
                portal_growth._send_command(
                    cur, client_id, str(row.get("contact_id") or ""), display,
                    body, "sequence", broadcast_id=None,
                )
            finished = len(upcoming) == 1
            if finished:
                cur.execute(
                    "UPDATE " + portal_db._q(ENROLLMENTS_TABLE) +
                    " SET current_step = %s, status = 'completed' WHERE id = %s",
                    (int(step.get("step_no") or 0), row.get("id")),
                )
            else:
                cur.execute(
                    "UPDATE " + portal_db._q(ENROLLMENTS_TABLE) +
                    " SET current_step = %s,"
                    " next_at = NOW() + make_interval(hours => %s)"
                    " WHERE id = %s",
                    (int(step.get("step_no") or 0),
                     int(upcoming[1].get("delay_hours") or 0), row.get("id")),
                )
            cur.execute(
                "INSERT INTO " + portal_db._q(STEP_LOG_TABLE) +
                " (client_id, sequence_id, enrollment_id, step_no, action)"
                " VALUES (%s, %s, %s, %s, %s)",
                (client_id, row.get("sequence_id"), row.get("id"),
                 int(step.get("step_no") or 0), "skipped" if skip else "sent"),
            )
            changed += 1
            if not skip:
                sent += 1
        if changed:
            conn.commit()
        return sent
    except Exception as error:
        logger.warning("sequence delivery pass failed: %s", error)
        return 0
