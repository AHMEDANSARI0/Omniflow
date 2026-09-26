"""
OmniFlow Control Plane — portal module database access (Neon PostgreSQL).

Owns the seven portal tables (see migrations/008_portal_connector.sql):
  portal_whatsapp_status     — connector-reported WhatsApp state per client
  portal_bot_configs         — customer's AI agent configuration per client
  portal_connector_commands  — command queue (portal -> laptop connector)
  portal_profiles            — customer business profile (JSONB doc)
  portal_api_keys            — customer portal API keys (ofk_..., SHA-256 stored)
  portal_conversations       — inbound/outbound conversations per contact
  portal_messages            — messages inside a conversation

Tables are created lazily and idempotently (IF NOT EXISTS) on first use, so
deploying this module needs NO manual migration step. The SQL file remains
available for explicit application in the Neon SQL editor.
"""

import logging
import os
import threading
from typing import Any, Dict, List


logger = logging.getLogger("omniflow.portal-db")

STATUS_TABLE = os.environ.get("OF_WA_STATUS_TABLE", "portal_whatsapp_status")
BOT_TABLE = os.environ.get("OF_BOT_TABLE", "portal_bot_configs")
CMD_TABLE = os.environ.get("OF_CMD_TABLE", "portal_connector_commands")
PROFILE_TABLE = os.environ.get("OF_PROFILE_TABLE", "portal_profiles")
APIKEY_TABLE = os.environ.get("OF_APIKEY_TABLE", "portal_api_keys")
CONV_TABLE = os.environ.get("OF_CONV_TABLE", "portal_conversations")
MSGS_TABLE = os.environ.get("OF_MSGS_TABLE", "portal_messages")
USERS_TABLE = os.environ.get("OF_USERS_TABLE", "platform_users")
USER_EMAIL_COL = os.environ.get("OF_USER_EMAIL_COL", "email")
NOTES_TABLE = os.environ.get("OF_NOTES_TABLE", "portal_conversation_notes")
BROADCASTS_TABLE = os.environ.get("OF_BROADCASTS_TABLE", "portal_broadcasts")
GAPS_TABLE = os.environ.get("OF_GAPS_TABLE", "portal_kb_gaps")
CSAT_TABLE = os.environ.get("OF_CSAT_TABLE", "portal_csat_requests")
SAVED_REPLIES_TABLE = os.environ.get("OF_SAVED_REPLIES_TABLE", "portal_saved_replies")

_ensure_lock = threading.Lock()
_ensured = False

_DDL = """
CREATE TABLE IF NOT EXISTS portal_whatsapp_status (
  client_id BIGINT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'disconnected',
  phone TEXT,
  account_name TEXT,
  last_seen_at TIMESTAMPTZ,
  reported_by BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS portal_bot_configs (
  client_id BIGINT PRIMARY KEY,
  agent_name TEXT NOT NULL DEFAULT 'OmniFlow Assistant',
  tone TEXT NOT NULL DEFAULT 'friendly',
  greeting TEXT NOT NULL DEFAULT '',
  fallback TEXT NOT NULL DEFAULT '',
  working_hours_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  working_hours_start TEXT NOT NULL DEFAULT '09:00',
  working_hours_end TEXT NOT NULL DEFAULT '18:00',
  human_handoff_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS portal_connector_commands (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  action TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by BIGINT,
  result_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_cmds_pending
  ON portal_connector_commands (client_id, status, id);
CREATE TABLE IF NOT EXISTS portal_profiles (
  client_id BIGINT PRIMARY KEY,
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS portal_api_keys (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  token_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_last4 TEXT NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_portal_api_keys_hash
  ON portal_api_keys (token_hash);
CREATE INDEX IF NOT EXISTS idx_portal_api_keys_client
  ON portal_api_keys (client_id);
CREATE TABLE IF NOT EXISTS portal_conversations (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  contact_id TEXT NOT NULL,
  contact_name TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  last_message_preview TEXT,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_portal_conversation UNIQUE (client_id, channel, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_portal_conversations_list
  ON portal_conversations (client_id, last_message_at DESC);
CREATE TABLE IF NOT EXISTS portal_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL,
  client_id BIGINT NOT NULL,
  direction TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  sender_name TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_messages_conv
  ON portal_messages (conversation_id, id);
CREATE TABLE IF NOT EXISTS portal_conversation_notes (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  author_email TEXT,
  body TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_conv_notes
  ON portal_conversation_notes (conversation_id, id DESC);
CREATE TABLE IF NOT EXISTS portal_broadcasts (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'all',
  body TEXT NOT NULL,
  recipient_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_broadcasts
  ON portal_broadcasts (client_id, id DESC);
CREATE TABLE IF NOT EXISTS portal_kb_gaps (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  question TEXT NOT NULL DEFAULT '',
  intent TEXT NOT NULL DEFAULT 'general',
  resolved INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_portal_kb_gaps
  ON portal_kb_gaps (client_id, resolved, id DESC);
CREATE TABLE IF NOT EXISTS portal_csat_requests (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL UNIQUE,
  contact_id TEXT NOT NULL,
  contact_name TEXT,
  score INT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_portal_csat_requests
  ON portal_csat_requests (client_id, requested_at DESC);
"""


def _q(ident: str) -> str:
    """Quote a dynamic identifier (config values, never user input)."""
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


def ensure_tables() -> None:
    """Idempotent, runs at most once per instance on success."""
    global _ensured
    if _ensured:
        return
    with _ensure_lock:
        if _ensured:
            return
        conn = _conn()
        try:
            with conn.cursor() as cur:
                cur.execute(_DDL)
            conn.commit()
            _ensured = True
            logger.info(
                "portal tables ensured (%s/%s/%s + profiles/apikeys/conversations)",
                STATUS_TABLE, BOT_TABLE, CMD_TABLE,
            )
        finally:
            conn.close()


def rows(cur) -> List[Dict[str, Any]]:
    """Cursor rows as plain dicts keyed by column name.

    Defensive: some drivers expose description=None for zero-row
    non-SELECT statements — treat that as an empty result.
    """
    if cur.description is None:
        return []
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def portal_unavailable(error: Exception, context: str) -> Any:
    """Log + return the 503 response used by every portal/connector route."""
    logger.exception("portal storage failure: %s", context)
    return (
        {"error": {"code": "portal_unavailable",
                   "message": "Storage is temporarily unavailable, try again shortly."}},
        503,
    )

TEAM_TABLE = os.environ.get("OF_TEAM_TABLE", "portal_team_members")
CONV_TAGS_TABLE = os.environ.get("OF_CONV_TAGS_TABLE", "portal_conversation_tags")


def log_action(cur, client_id, action, actor_kind="customer_user",
               actor_user_id=None, conversation_id=None, note=""):
    """Append one row to the action audit log (portal_action_log)."""
    cur.execute(
        "INSERT INTO " + _q("portal_action_log") +
        " (client_id, action, actor_kind, actor_user_id, conversation_id,"
        " note, created_at) VALUES (%s, %s, %s, %s, %s, %s, NOW())",
        (client_id, action, actor_kind, actor_user_id, conversation_id, note),
    )
