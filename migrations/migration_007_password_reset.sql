-- -- OmniFlow — MIGRATION 007: password reset tokens (NEW migration — do NOT touch 001-006)
-- -- Run ONCE in Neon console → SQL Editor. This is a new migration, not a re-apply of 001-006.

-- CREATE TABLE IF NOT EXISTS password_reset_tokens (
--     id          BIGSERIAL PRIMARY KEY,
--     user_id     BIGINT NOT NULL,
--     token_hash  TEXT NOT NULL,              -- SHA-256 of the 6-digit code (plain code never stored)
--     expires_at  TIMESTAMPTZ NOT NULL,
--     attempts    INT NOT NULL DEFAULT 0,     -- failed code attempts (cap = 3)
--     used_at     TIMESTAMPTZ,                -- set when consumed; once used, code is dead
--     created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
-- );

-- CREATE INDEX IF NOT EXISTS idx_password_reset_user
--     ON password_reset_tokens (user_id);
-- CREATE INDEX IF NOT EXISTS idx_password_reset_hash
--     ON password_reset_tokens (token_hash);
-- CREATE INDEX IF NOT EXISTS idx_password_reset_expiry
--     ON password_reset_tokens (expires_at);
