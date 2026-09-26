BEGIN;

-- ============================================================
-- Replay-safe refresh-token rotation history
-- ============================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace
          AND conrelid = 'platform_user_sessions'::regclass
          AND conname = 'platform_user_sessions_identity_unique'
    ) THEN
        ALTER TABLE platform_user_sessions
        ADD CONSTRAINT platform_user_sessions_identity_unique
        UNIQUE (id, user_id, client_id);
    END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS platform_refresh_token_history (
    id BIGSERIAL PRIMARY KEY,
    session_id UUID NOT NULL,
    user_id BIGINT NOT NULL,
    client_id BIGINT NOT NULL,
    token_hash CHAR(64) NOT NULL,
    consumed_at TIMESTAMP WITH TIME ZONE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT platform_refresh_history_session_fkey
        FOREIGN KEY (session_id, user_id, client_id)
        REFERENCES platform_user_sessions(id, user_id, client_id)
        ON DELETE CASCADE,

    CONSTRAINT platform_refresh_history_hash_unique
        UNIQUE (token_hash),

    CONSTRAINT platform_refresh_history_hash_check
        CHECK (
            token_hash = LOWER(token_hash)
            AND token_hash ~ '^[0-9a-f]{64}$'
        ),

    CONSTRAINT platform_refresh_history_expiry_check
        CHECK (expires_at > consumed_at)
);

CREATE INDEX IF NOT EXISTS idx_platform_refresh_history_session
ON platform_refresh_token_history (
    session_id,
    consumed_at DESC,
    id DESC
);

CREATE INDEX IF NOT EXISTS idx_platform_refresh_history_expiry
ON platform_refresh_token_history (
    expires_at,
    id
);

-- ============================================================
-- Post-migration tenant and plaintext invariants
-- ============================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM platform_refresh_token_history history
        LEFT JOIN platform_user_sessions session
          ON session.id = history.session_id
         AND session.user_id = history.user_id
         AND session.client_id = history.client_id
        WHERE session.id IS NULL
    ) THEN
        RAISE EXCEPTION
            'Migration invariant failed: cross-tenant refresh history';
    END IF;
END;
$$;

COMMIT;
