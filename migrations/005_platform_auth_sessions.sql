BEGIN;

-- ============================================================
-- Opaque, revocable customer login sessions
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_user_sessions (
    id UUID PRIMARY KEY,
    user_id BIGINT NOT NULL,
    client_id BIGINT NOT NULL,
    access_token_hash CHAR(64) NOT NULL,
    refresh_token_hash CHAR(64) NOT NULL,
    status VARCHAR(20)
        NOT NULL DEFAULT 'active',
    auth_method VARCHAR(30)
        NOT NULL DEFAULT 'password',
    issued_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    access_expires_at
        TIMESTAMP WITH TIME ZONE NOT NULL,
    refresh_expires_at
        TIMESTAMP WITH TIME ZONE NOT NULL,
    last_seen_at TIMESTAMP WITH TIME ZONE,
    revoked_at TIMESTAMP WITH TIME ZONE,
    metadata JSONB
        NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT
        platform_user_sessions_membership_fkey
        FOREIGN KEY (client_id, user_id)
        REFERENCES client_memberships(
            client_id,
            user_id
        )
        ON DELETE CASCADE,

    CONSTRAINT
        platform_user_sessions_access_hash_unique
        UNIQUE (access_token_hash),

    CONSTRAINT
        platform_user_sessions_refresh_hash_unique
        UNIQUE (refresh_token_hash),

    CONSTRAINT
        platform_user_sessions_status_check
        CHECK (
            status IN (
                'active',
                'revoked',
                'expired'
            )
        ),

    CONSTRAINT
        platform_user_sessions_auth_method_check
        CHECK (
            auth_method IN (
                'password',
                'refresh_token'
            )
        ),

    CONSTRAINT
        platform_user_sessions_expiry_check
        CHECK (
            access_expires_at > issued_at
            AND refresh_expires_at
                > access_expires_at
        ),

    CONSTRAINT
        platform_user_sessions_revocation_check
        CHECK (
            (
                status = 'active'
                AND revoked_at IS NULL
            )
            OR
            (
                status IN (
                    'revoked',
                    'expired'
                )
                AND revoked_at IS NOT NULL
            )
        ),

    CONSTRAINT
        platform_user_sessions_access_hash_check
        CHECK (
            access_token_hash
                = LOWER(access_token_hash)
            AND access_token_hash
                ~ '^[0-9a-f]{64}$'
        ),

    CONSTRAINT
        platform_user_sessions_refresh_hash_check
        CHECK (
            refresh_token_hash
                = LOWER(refresh_token_hash)
            AND refresh_token_hash
                ~ '^[0-9a-f]{64}$'
        )
);

CREATE INDEX IF NOT EXISTS
    idx_platform_user_sessions_access
ON platform_user_sessions (
    access_token_hash,
    status,
    access_expires_at
);

CREATE INDEX IF NOT EXISTS
    idx_platform_user_sessions_refresh
ON platform_user_sessions (
    refresh_token_hash,
    status,
    refresh_expires_at
);

CREATE INDEX IF NOT EXISTS
    idx_platform_user_sessions_user
ON platform_user_sessions (
    user_id,
    client_id,
    status,
    refresh_expires_at DESC
);

-- ============================================================
-- Post-migration tenant invariant
-- ============================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM platform_user_sessions session
        LEFT JOIN client_memberships membership
          ON membership.user_id
             = session.user_id
         AND membership.client_id
             = session.client_id
        WHERE membership.id IS NULL
    ) THEN
        RAISE EXCEPTION 'Migration invariant failed: cross-tenant platform session';
    END IF;
END;
$$;

COMMIT;
