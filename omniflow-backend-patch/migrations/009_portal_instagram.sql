-- Instagram-first omnichannel adapter.
-- Credentials are workspace scoped and intentionally have no defaults.
CREATE TABLE IF NOT EXISTS portal_instagram_accounts (
  client_id BIGINT PRIMARY KEY,
  instagram_account_id TEXT NOT NULL DEFAULT '',
  page_id TEXT NOT NULL DEFAULT '',
  app_secret TEXT NOT NULL DEFAULT '',
  access_token TEXT NOT NULL DEFAULT '',
  verify_token TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_check_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_account_id
  ON portal_instagram_accounts (instagram_account_id)
  WHERE instagram_account_id <> '';
