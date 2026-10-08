"""Outbox for the channels the Control Plane delivers itself (§244).

Email (§243) and SMS (§244) have no laptop bridge: the Control Plane sends
their queued replies itself - rows in the shared command queue
(``portal_db.CMD_TABLE``, channel = the adapter) and away replies
(``portal_away_replies`` rows whose contact id carries the channel prefix).
These helpers are the one place those rows are read and finished, so every
Control-Plane channel acks, retries and refuses the same way:

* sent     -> command "done" + ``portal_events.on_command_ack`` (ok), or the
              away reply "sent";
* retry    -> command back to "pending" + on_command_ack (not ok), which
              schedules the shared backoff (and dead after the last try);
              away replies have no retry and are marked "failed";
* refused  -> command dead with the reason (never retried), away "failed".

Sent replies are recorded in the conversation through the one ingest core
(direction "out", so no hook answers them), like the WhatsApp bridge does.
"""

import json
import logging
from typing import Any, Dict, List, Optional

import portal_db

logger = logging.getLogger("omniflow.cp_outbox")

AWAY_TABLE = "portal_away_replies"


def pending(cur, client_id: int, channel: str, prefix: Any, limit: int) -> List[Dict[str, Any]]:
    """Due queued replies (commands) for the channel, then pending away
    replies for its contacts. Oldest first; tenant-scoped. ``prefix`` is one
    contact prefix or a tuple of them (§256: Meta DMs and comments)."""
    prefixes = [prefix] if isinstance(prefix, str) else [str(p) for p in prefix]
    import portal_events

    portal_events._ensure_ddl(cur)
    portal_events.requeue_due_commands(cur, client_id)
    cur.execute("SELECT id, action, payload FROM " + portal_db._q(portal_db.CMD_TABLE) +
                " WHERE client_id = %s AND channel = %s AND status = 'pending'"
                " AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())"
                " ORDER BY id ASC LIMIT %s", (client_id, channel, limit))
    out = []
    for row in portal_db.rows(cur):
        payload = row.get("payload")
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except ValueError:
                payload = {}
        out.append({"kind": "command", "id": int(row["id"]),
                    "action": str(row.get("action") or ""),
                    "payload": payload if isinstance(payload, dict) else {}})
    cur.execute("SELECT to_regclass(%s) AS t", (AWAY_TABLE,))
    found = portal_db.rows(cur)
    if found and found[0].get("t"):
        cur.execute("SELECT id, contact_id, body FROM " + portal_db._q(AWAY_TABLE) +
                    " WHERE client_id = %s AND status = 'pending' AND contact_id LIKE ANY(%s)"
                    " ORDER BY id ASC LIMIT %s", (client_id, [p + "%" for p in prefixes], limit))
        for row in portal_db.rows(cur):
            out.append({"kind": "away", "id": int(row["id"]), "action": "send_message",
                        "payload": {"external_user_id": row.get("contact_id"),
                                    "body": row.get("body"), "source": "away"}})
    return out


def _away(cur, client_id: int, away_id: int, ok: bool, note: str) -> None:
    cur.execute("UPDATE " + portal_db._q(AWAY_TABLE) +
                " SET status = %s, result_note = %s, sent_at = NOW()"
                " WHERE id = %s AND client_id = %s AND status = 'pending'",
                ("sent" if ok else "failed", note[:500], away_id, client_id))


def _ack(cur, client_id: int, channel: str, command_id: int, ok: bool, note: str,
         provider_message_id: Optional[str]) -> None:
    import portal_events

    cur.execute("UPDATE " + portal_db._q(portal_db.CMD_TABLE) +
                " SET status = %s, result_note = %s, updated_at = NOW()"
                " WHERE id = %s AND client_id = %s AND channel = %s",
                ("done" if ok else "pending", note[:500], command_id, client_id, channel))
    portal_events.on_command_ack(cur, client_id, command_id, ok, note[:500],
                                 provider_message_id)


def sent(cur, client_id: int, channel: str, item: Dict[str, Any], note: str,
         provider_message_id: Optional[str]) -> None:
    if item["kind"] == "command":
        _ack(cur, client_id, channel, item["id"], True, note, provider_message_id)
    else:
        _away(cur, client_id, item["id"], True, note)


def retry(cur, client_id: int, channel: str, item: Dict[str, Any], note: str) -> None:
    if item["kind"] == "command":
        _ack(cur, client_id, channel, item["id"], False, note, None)
    else:
        _away(cur, client_id, item["id"], False, note)


def refuse(cur, client_id: int, channel: str, item: Dict[str, Any], note: str) -> None:
    import portal_events

    if item["kind"] != "command":
        _away(cur, client_id, item["id"], False, note)
        return
    cur.execute("UPDATE " + portal_db._q(portal_db.CMD_TABLE) +
                " SET status = %s, result_note = %s, error_code = 'refused',"
                " error_message = %s, next_attempt_at = NULL, updated_at = NOW()"
                " WHERE id = %s AND client_id = %s AND channel = %s",
                (portal_events._DEAD, note[:500], note[:500], item["id"], client_id, channel))


def ingest(client_id: int, channel: str, source: str, items: List[Dict[str, Any]]) -> int:
    """Run the one ingest core for adapter records (raises like it does)."""
    import connector_api

    normalized = connector_api.normalize_messages(items, default_channel=channel)
    return connector_api.ingest_messages_for_tenant(
        {"client_id": client_id, "user_id": None, "source": source}, normalized)


def record_sent(client_id: int, channel: str, source: str, records: List[Dict[str, Any]]) -> None:
    """Show sent replies in the conversation (direction "out"). Fail-soft."""
    if not records:
        return
    try:
        ingest(client_id, channel, source, records)
    except Exception as error:
        logger.warning("%s outbound record failed: %s", channel, error)
