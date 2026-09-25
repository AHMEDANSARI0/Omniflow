"""
OmniFlow Control Plane — CONNECTOR endpoints (WhatsApp connector bridge).

Ye endpoints customer ke apne device (home laptop) par chalne wale connector
ke liye hain — server par WhatsApp session KABHI nahi chalta. Auth:
X-Omniflow-Key header = OMNIFLOW_SERVICE_KEY ya OMNIFLOW_ADMIN_API_KEY
(wahi proven pattern jo admin endpoints use karte hain).

Connector ka tenant resolve hota hai (pehla match jeeta):
  1. Request body/query me explicit `client_id`
  2. Backend env OMNIFLOW_CONNECTOR_USER_EMAIL -> platform_users lookup

Endpoints:
  POST /api/v1/connector/whatsapp/status          {state, phone?, account_name?, client_id?}
  GET  /api/v1/connector/whatsapp/commands        ?limit=20  (pending, oldest first)
  POST /api/v1/connector/whatsapp/commands/ack    {command_id, ok, note?, client_id?}
  GET  /api/v1/connector/bot                      (tenant ka agent config)
  POST /api/v1/connector/whatsapp/messages        {messages:[{from, body, name?, direction?}]}
                                                  -> conversation upsert + message store
"""

import logging
import os
import secrets
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from flask import Blueprint, jsonify, request

import portal_db
import portal_cod
import portal_contacts
import portal_sequences


logger = logging.getLogger("omniflow.connector-api")

bp = Blueprint("connector_api", __name__, url_prefix="/api/v1/connector")

ALLOWED_STATES = ("disconnected", "connecting", "connected")
_TENANT_TTL_SECONDS = 300.0
_tenant_lock = threading.Lock()
_tenant_cache: Dict[str, Any] = {"email": None, "value": None, "at": 0.0}


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


def _resolve_tenant(explicit_client_id: Any) -> Optional[Dict[str, Any]]:
    """client_id (explicit > env email lookup). None = not configurable."""
    if isinstance(explicit_client_id, str) and explicit_client_id.strip().isdigit():
        explicit_client_id = int(explicit_client_id.strip())
    if isinstance(explicit_client_id, int) and not isinstance(explicit_client_id, bool) \
            and explicit_client_id > 0:
        return {"client_id": explicit_client_id, "user_id": None, "source": "request"}

    email = os.environ.get("OMNIFLOW_CONNECTOR_USER_EMAIL", "").strip().lower()
    if not email:
        return None

    now = time.time()
    with _tenant_lock:
        cached = (
            _tenant_cache["email"] == email
            and _tenant_cache["value"] is not None
            and (now - float(_tenant_cache["at"])) < _TENANT_TTL_SECONDS
        )
        if cached:
            return dict(_tenant_cache["value"])

    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, client_id FROM " + portal_db._q(portal_db.USERS_TABLE) +
                " WHERE " + portal_db._q(portal_db.USER_EMAIL_COL) + " = %s LIMIT 1",
                (email,),
            )
            found = portal_db.rows(cur)
    finally:
        conn.close()

    if not found:
        return None
    tenant = {"client_id": found[0]["client_id"], "user_id": found[0]["id"], "source": "env"}
    with _tenant_lock:
        _tenant_cache.update({"email": email, "value": tenant, "at": now})
    return dict(tenant)


def _tenant_or_error(explicit_client_id: Any):
    try:
        tenant = _resolve_tenant(explicit_client_id)
    except Exception as error:
        return None, (jsonify(portal_db.portal_unavailable(error, "tenant resolve")[0]), 503)
    if tenant is None:
        return None, (jsonify({"error": {
            "code": "connector_not_configured",
            "message": (
                "Connector tenant resolve nahi hua: body/query me client_id bhejein "
                "ya backend par OMNIFLOW_CONNECTOR_USER_EMAIL set karein."
            ),
        }}), 503)
    return tenant, None


def _json_body() -> Dict[str, Any]:
    payload = request.get_json(silent=True)
    return payload if isinstance(payload, dict) else {}


def _query_int(name: str, default: int, low: int, high: int) -> int:
    raw = request.args.get(name, "")
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, value))


@bp.post("/whatsapp/status")
def report_status():
    payload = _json_body()
    tenant, error = _tenant_or_error(payload.get("client_id"))
    if error:
        return error

    state = payload.get("state")
    if state not in ALLOWED_STATES:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "state disconnected|connecting|connected hon."}}), 400
    phone = payload.get("phone")
    phone = phone.strip() if isinstance(phone, str) else None
    account_name = payload.get("account_name")
    account_name = account_name.strip() if isinstance(account_name, str) else None

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(portal_db.STATUS_TABLE) +
                    " (client_id, state, phone, account_name, last_seen_at,"
                    " reported_by, updated_at) "
                    "VALUES (%s, %s, %s, %s, NOW(), %s, NOW()) "
                    "ON CONFLICT (client_id) DO UPDATE SET "
                    " state = EXCLUDED.state,"
                    " phone = EXCLUDED.phone,"
                    " account_name = EXCLUDED.account_name,"
                    " last_seen_at = EXCLUDED.last_seen_at,"
                    " reported_by = EXCLUDED.reported_by,"
                    " updated_at = NOW()",
                    (tenant["client_id"], state, phone, account_name, tenant["user_id"]),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "wa status write")[0]), 503

    return jsonify({"ok": True}), 200


@bp.get("/whatsapp/commands")
def list_commands():
    args = request.args
    tenant, error = _tenant_or_error(args.get("client_id"))
    if error:
        return error
    limit = _query_int("limit", 20, 1, 50)
    channel = (args.get("channel") or "").strip()
    if channel and channel not in ALLOWED_CHANNELS:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "channel whatsapp|telegram hon."}}), 400

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                try:
                    import portal_growth

                    portal_growth.materialize_due_broadcasts(cur, tenant["client_id"], conn)
                    import portal_digest

                    portal_digest.materialize_due_digest(
                        cur, tenant["client_id"], conn
                    )

                    import portal_checkout

                    portal_checkout.materialize_cart_reminders(
                        cur, tenant["client_id"], conn
                    )

                except Exception:
                    pass
                try:
                    import portal_webhooks

                    portal_webhooks.deliver_pending_webhooks(
                        cur, tenant["client_id"], conn
                    )
                except Exception:
                    pass
                try:
                    import portal_sequences

                    portal_sequences.deliver_due_sequence_steps(
                        cur, tenant["client_id"], conn
                    )
                except Exception:
                    pass
                try:
                    import portal_events

                    portal_events.requeue_due_commands(
                        cur, tenant["client_id"]
                    )
                except Exception:
                    pass
                cmd_sql = (
                    "SELECT id, action, payload, created_at FROM "
                    + portal_db._q(portal_db.CMD_TABLE) +
                    " WHERE client_id = %s AND status = 'pending'"
                    " AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())"
                )
                cmd_params: list = [tenant["client_id"]]
                if channel:
                    cmd_sql += " AND channel = %s"
                    cmd_params.append(channel)
                cmd_sql += " ORDER BY id ASC LIMIT %s"
                cmd_params.append(limit)
                cur.execute(cmd_sql, tuple(cmd_params))
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "commands read")[0]), 503

    commands = []
    for row in found:
        created = row.get("created_at")
        if isinstance(created, datetime) and created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        commands.append({
            "id": row.get("id"),
            "action": row.get("action"),
            "payload": row.get("payload") or {},
            "created_at": created.isoformat() if isinstance(created, datetime) else None,
        })
    return jsonify({"commands": commands}), 200


@bp.post("/whatsapp/commands/ack")
def ack_command():
    payload = _json_body()
    tenant, error = _tenant_or_error(payload.get("client_id"))
    if error:
        return error

    command_id = payload.get("command_id")
    if isinstance(command_id, bool) or not isinstance(command_id, int) or command_id <= 0:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "command_id (positive int) zaroori hai."}}), 400
    ok_flag = payload.get("ok") is True
    note = payload.get("note")
    note = note if isinstance(note, str) else None

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(portal_db.CMD_TABLE) +
                    " SET status = %s, result_note = %s, updated_at = NOW() "
                    "WHERE id = %s AND client_id = %s RETURNING id",
                    ("done" if ok_flag else "failed", note, command_id, tenant["client_id"]),
                )
                try:
                    import portal_events

                    portal_events.on_command_ack(
                        cur,
                        tenant["client_id"],
                        command_id,
                        ok_flag,
                        note,
                        payload.get("provider_message_id"),
                    )
                except Exception:
                    pass
                updated = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "command ack")[0]), 503

    if not updated:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Command nahi mili."}}), 404
    return jsonify({"ok": True}), 200


@bp.get("/bot")
def connector_bot_config():
    tenant, error = _tenant_or_error(request.args.get("client_id"))
    if error:
        return error

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT agent_name, tone, greeting, fallback,"
                    " working_hours_enabled, working_hours_start, working_hours_end,"
                    " human_handoff_enabled, updated_at"
                    " FROM " + portal_db._q(portal_db.BOT_TABLE) +
                    " WHERE client_id = %s",
                    (tenant["client_id"],),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "connector bot read")[0]), 503

    if not found:
        return jsonify({
            "agent_name": "OmniFlow Assistant",
            "tone": "friendly",
            "greeting": "",
            "fallback": "",
            "working_hours_enabled": False,
            "working_hours_start": "09:00",
            "working_hours_end": "18:00",
            "human_handoff_enabled": False,
            "updated_at": None,
        }), 200

    row = found[0]
    updated = row.get("updated_at")
    if isinstance(updated, datetime) and updated.tzinfo is None:
        updated = updated.replace(tzinfo=timezone.utc)
    return jsonify({
        "agent_name": row.get("agent_name") or "OmniFlow Assistant",
        "tone": row.get("tone") if row.get("tone") in ("friendly", "professional", "concise") else "friendly",
        "greeting": row.get("greeting") or "",
        "fallback": row.get("fallback") or "",
        "working_hours_enabled": row.get("working_hours_enabled") is True,
        "working_hours_start": row.get("working_hours_start") or "09:00",
        "working_hours_end": row.get("working_hours_end") or "18:00",
        "human_handoff_enabled": row.get("human_handoff_enabled") is True,
        "updated_at": updated.isoformat() if isinstance(updated, datetime) else None,
    }), 200


MAX_INGEST_MESSAGES = 100
ALLOWED_DIRECTIONS = ("in", "out")
ALLOWED_CHANNELS = ("whatsapp", "telegram")


_AWAY_TABLE_READY = False
AWAY_COOLDOWN_HOURS = 4
_AWAY_DEFAULTS = {
    "enabled": False,
    "timezone": "Asia/Karachi",
    "days": [
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
    ],
    "away_message": "",
}


def _ensure_away_table() -> None:
    global _AWAY_TABLE_READY
    if _AWAY_TABLE_READY:
        return
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "CREATE TABLE IF NOT EXISTS " + portal_db._q("portal_away_replies") +
                " (id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL,"
                " conversation_id BIGINT, contact_id TEXT NOT NULL,"
                " body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',"
                " result_note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
                " sent_at TIMESTAMPTZ)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS portal_away_pending_idx ON " +
                portal_db._q("portal_away_replies") +
                " (client_id, status, id)"
            )
        conn.commit()
    finally:
        conn.close()
    _AWAY_TABLE_READY = True


def _load_business_hours(cur, client_id):
    try:
        cur.execute(
            "SELECT settings -> 'business_hours' AS business_hours FROM " +
            portal_db._q("client_settings") +
            " WHERE client_id = %s",
            (client_id,),
        )
        rows = portal_db.rows(cur)
    except Exception:
        return _AWAY_DEFAULTS
    stored = rows[0].get("business_hours") if rows and rows[0] else None
    return stored if isinstance(stored, dict) else _AWAY_DEFAULTS


def _away_closed_now(config) -> bool:
    try:
        from zoneinfo import ZoneInfo

        days = config.get("days")
        if not isinstance(days, list) or len(days) != 7:
            return False
        now = datetime.now(ZoneInfo(str(config.get("timezone") or "UTC")))
        day = days[(now.weekday() + 1) % 7]
        if not isinstance(day, dict) or day.get("enabled") is not True:
            return True
        current = now.strftime("%H:%M")
        start = day.get("start")
        end = day.get("end")
        if not isinstance(start, str) or not isinstance(end, str):
            return True
        return not (start <= current <= end)
    except Exception:
        return False


def _maybe_enqueue_away_reply(client_id, conversation_id, contact_id, direction, conn) -> Optional[bool]:
    """Queue one automatic away reply, inside the ingest transaction.

    Fires only for inbound messages while business hours are enabled and
    currently closed, at most once per conversation per cooldown window.
    Never raises into the caller: wrap in try/except there.
    """
    if direction != "in":
        return
    with conn.cursor() as cur:
        config = _load_business_hours(cur, client_id)
        message = config.get("away_message")
        if (
            config.get("enabled") is not True
            or not isinstance(message, str)
            or not message.strip()
        ):
            return
        if not _away_closed_now(config):
            return
        cur.execute(
            "SELECT 1 FROM " + portal_db._q("portal_away_replies") +
            " WHERE client_id = %s AND conversation_id = %s"
            " AND created_at > NOW() - INTERVAL '" +
            str(AWAY_COOLDOWN_HOURS) + " hours'"
            " LIMIT 1",
            (client_id, conversation_id),
        )
        if portal_db.rows(cur):
            return
        try:
            contact_lang = portal_contacts.stored_language(
                cur, client_id, contact_id)
        except Exception:
            contact_lang = None
        if contact_lang == "ur":
            variant = config.get("away_message_ur")
        elif contact_lang == "roman":
            variant = config.get("away_message_roman")
        else:
            variant = None
        if isinstance(variant, str) and variant.strip():
            message = variant
        cur.execute(
            "INSERT INTO " + portal_db._q("portal_away_replies") +
            " (client_id, conversation_id, contact_id, body)"
            " VALUES (%s, %s, %s, %s)",
            (client_id, conversation_id, contact_id, message.strip()),
        )
        return True


@bp.get("/away-replies")
def list_due_away_replies():
    args = request.args
    tenant, error = _tenant_or_error(args.get("client_id"))
    if error:
        return error
    limit = _query_int("limit", 5, 1, 20)

    try:
        _ensure_away_table()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, contact_id, body, created_at FROM " +
                    portal_db._q("portal_away_replies") +
                    " WHERE client_id = %s AND status = 'pending'"
                    " AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())"
                    " ORDER BY id ASC LIMIT %s",
                    (tenant["client_id"], limit),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "away replies read")[0]), 503

    replies = []
    for row in found:
        created = row.get("created_at")
        if isinstance(created, datetime) and created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        replies.append({
            "id": row.get("id"),
            "external_user_id": row.get("contact_id"),
            "body": row.get("body"),
            "created_at": created.isoformat() if isinstance(created, datetime) else None,
        })
    return jsonify({"away_replies": replies}), 200


@bp.post("/away-replies/ack")
def ack_away_reply():
    payload = _json_body()
    tenant, error = _tenant_or_error(payload.get("client_id"))
    if error:
        return error

    away_id = payload.get("away_id")
    if isinstance(away_id, bool) or not isinstance(away_id, int) or away_id <= 0:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "away_id (positive int) zaroori hai."}}), 400
    ok_flag = payload.get("ok") is True
    note = payload.get("note")
    note = note if isinstance(note, str) else None

    try:
        _ensure_away_table()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q("portal_away_replies") +
                    " SET status = %s, result_note = %s, sent_at = NOW()"
                    " WHERE id = %s AND client_id = %s AND status = 'pending' RETURNING id",
                    ("sent" if ok_flag else "failed", note, away_id, tenant["client_id"]),
                )
                updated = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "away ack")[0]), 503

    if not updated:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Away reply nahi mili."}}), 404
    return jsonify({"ok": True}), 200


@bp.post("/whatsapp/messages")
def ingest_whatsapp_messages():
    """Store messages delivered by the customer's laptop connector.

    Body: {client_id?, messages: [{from, body?, name?, direction?}]}
      - from    (required, non-empty string) = WhatsApp chat id (contact)
      - body    (optional string)
      - name    (optional string) = contact display name
      - direction ("in" | "out", default "in")
    Conversations are upserted per (client_id, channel, contact_id) —
    UNIQUE constraint in portal_conversations.
    """
    payload = _json_body()
    tenant, error = _tenant_or_error(payload.get("client_id"))
    if error:
        return error

    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "messages (non-empty list) zaroori hai."}}), 400
    if len(messages) > MAX_INGEST_MESSAGES:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Aik request me max "
                                             + str(MAX_INGEST_MESSAGES)
                                             + " messages bhejein."}}), 400

    normalized = []
    for item in messages:
        if not isinstance(item, dict):
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Har message aik object ho."}}), 400
        sender = item.get("from")
        if not isinstance(sender, str) or not sender.strip():
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Har message me 'from' zaroori hai."}}), 400
        body = item.get("body")
        if body is None:
            body = ""
        elif not isinstance(body, str):
            body = str(body)
        try:
            import portal_interactive

            reply_body = portal_interactive.interactive_body_override(
                item.get("interactive"), body
            )
            if reply_body is not None:
                body = reply_body
        except Exception:
            pass
        direction = item.get("direction", "in")
        if direction not in ALLOWED_DIRECTIONS:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "direction in|out hon."}}), 400
        channel = item.get("channel", "whatsapp")
        if channel not in ALLOWED_CHANNELS:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "channel whatsapp|telegram hon."}}), 400
        name = item.get("name")
        name = name.strip() if isinstance(name, str) else None
        normalized.append({
            "from": sender.strip(),
            "body": body,
            "name": name,
            "direction": direction,
            "channel": channel,
        })

    inserted = 0
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                try:
                    import portal_ratelimit

                    if not portal_ratelimit.allow(
                        cur,
                        "ingest:" + str(tenant["client_id"]),
                        portal_ratelimit.ingest_limit(),
                        60,
                    ):
                        conn.commit()
                        return jsonify({"error": {
                            "code": "rate_limited",
                            "message": "Too many messages; slow down.",
                        }}), 429
                except Exception:
                    pass
                for item in normalized:
                    try:
                        import portal_events

                        if not portal_events.record_inbound(
                            cur, tenant["client_id"], item
                        ):
                            continue
                    except Exception:
                        pass
                    cur.execute(
                        "INSERT INTO " + portal_db._q(portal_db.CONV_TABLE) +
                        " (client_id, channel, contact_id, contact_name,"
                        " status, last_message_preview, last_message_at,"
                        " created_at, updated_at) "
                        "VALUES (%s, %s, %s, %s, 'open', %s, NOW(), NOW(), NOW()) "
                        "ON CONFLICT (client_id, channel, contact_id) DO UPDATE SET "
                        " contact_name = COALESCE(EXCLUDED.contact_name,"
                        " " + portal_db._q(portal_db.CONV_TABLE) + ".contact_name), "
                        " last_message_preview = EXCLUDED.last_message_preview, "
                        " last_message_at = EXCLUDED.last_message_at, "
                        " updated_at = NOW() "
                        "RETURNING id",
                        (tenant["client_id"], item["channel"], item["from"],
                         item["name"], item["body"]),
                    )
                    conv = portal_db.rows(cur)
                    conversation_id = conv[0]["id"] if conv else None
                    cur.execute(
                        "INSERT INTO " + portal_db._q(portal_db.MSGS_TABLE) +
                        " (conversation_id, client_id, direction, body,"
                        " sender_name, status, created_at) "
                        "VALUES (%s, %s, %s, %s, %s, %s, NOW())",
                        (conversation_id, tenant["client_id"], item["direction"],
                         item["body"], item["name"],
                         "received" if item["direction"] == "in" else "sent"),
                    )
                    # One-reply law (B2): the first automation that sends a
                    # customer-visible reply claims the message; the other
                    # reply hooks stay quiet. Side-effect hooks (language
                    # detection, compliance, listen, routing, sequences)
                    # always run.
                    claimed_by = None
                    if claimed_by is None:
                        try:
                            if _maybe_enqueue_away_reply(
                                tenant["client_id"],
                                conversation_id,
                                item["from"],
                                item["direction"],
                                conn,
                            ):
                                claimed_by = "away"
                        except Exception:
                            pass
                    if claimed_by is None:
                        try:
                            if portal_cod.maybe_cod_flow(
                                tenant["client_id"],
                                conversation_id,
                                item["from"],
                                item["name"],
                                item["body"],
                                item["direction"],
                                conn,
                            ):
                                claimed_by = "cod"
                        except Exception:
                            pass
                    if claimed_by is None:
                        try:
                            import portal_brain

                            if portal_brain.maybe_answer(
                                tenant["client_id"],
                                conversation_id,
                                item["from"],
                                item["name"],
                                item["body"],
                                conn,
                            ):
                                claimed_by = "brain"
                        except Exception:
                            pass
                    if claimed_by is None:
                        try:
                            import portal_kb
                            import portal_intents

                            intent = portal_intents.classify(item["body"])
                            if portal_kb.maybe_auto_reply(
                                tenant["client_id"],
                                conversation_id,
                                item["from"],
                                item["name"],
                                item["body"],
                                intent,
                                conn,
                            ):
                                claimed_by = "kb"
                        except Exception:
                            pass
                    if claimed_by:
                        try:
                            import portal_events

                            portal_events.note_claim(
                                cur, tenant["client_id"], item, claimed_by
                            )
                        except Exception:
                            pass
                    try:
                        portal_contacts.maybe_detect_language(
                            tenant["client_id"],
                            item["from"],
                            item["body"],
                            conn,
                        )
                    except Exception:
                        pass
                    if item["direction"] == "in":
                        try:
                            import portal_compliance

                            portal_compliance.maybe_opt_out(
                                tenant["client_id"],
                                item["from"],
                                item["body"],
                                conn,
                            )
                        except Exception:
                            pass
                        try:
                            import portal_listen

                            portal_listen.maybe_listen(
                                tenant["client_id"],
                                conversation_id,
                                item["from"],
                                item["body"],
                                conn,
                            )
                        except Exception:
                            pass
                        try:
                            import portal_routing

                            portal_routing.maybe_route(
                                tenant["client_id"],
                                conversation_id,
                                item["from"],
                                item["body"],
                                conn,
                            )
                        except Exception:
                            pass
                    try:
                        portal_sequences.maybe_enroll_new_contact(
                            tenant["client_id"],
                            conversation_id,
                            item["from"],
                            item["name"],
                            conn,
                        )
                    except Exception:
                        pass
                    try:
                        portal_sequences.maybe_enroll_keyword(
                            tenant["client_id"],
                            conversation_id,
                            item["from"],
                            item["name"],
                            item["body"],
                            conn,
                        )
                    except Exception:
                        pass
                    try:
                        portal_sequences.maybe_auto_pause_replies(
                            tenant["client_id"],
                            conversation_id,
                            conn,
                        )
                    except Exception:
                        pass
                    try:
                        import portal_events

                        portal_events.mark_inbound_done(
                            cur, tenant["client_id"], item
                        )
                    except Exception:
                        pass
                    inserted += 1
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "wa messages ingest")[0]), 503

    logger.info("whatsapp messages ingested client_id=%s count=%s",
                tenant["client_id"], inserted)
    return jsonify({"ok": True, "inserted": inserted}), 200
