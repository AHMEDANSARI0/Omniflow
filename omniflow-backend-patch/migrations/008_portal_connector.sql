-- OmniFlow Control Plane — migration 008: portal + connector tables
-- Idempotent (IF NOT EXISTS) — chahye to Neon SQL editor me dobara bhi chala jaye.
-- NOTE: backend module (portal_db.py) ye tables lazily khud bhi bana deta hai,
-- ye file explicit application ke liye hai.

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
