BEGIN;
-- ============================================================
-- Managed connector/control-plane foundation
-- ============================================================
-- This migration is additive. Existing channel accounts
-- remain local_web until explicitly migrated in the future.

ALTER TABLE channel_accounts
ADD COLUMN IF NOT EXISTS connection_mode VARCHAR(30)
NOT NULL DEFAULT 'local_web';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'channel_accounts_connection_mode_check'
          AND conrelid = 'channel_accounts'::regclass
    ) THEN
        ALTER TABLE channel_accounts
        ADD CONSTRAINT channel_accounts_connection_mode_check
        CHECK (
            connection_mode IN (
                'local_web',
                'managed_web',
                'client_edge',
                'cloud_api'
            )
        );
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'channel_accounts_id_client_unique'
          AND conrelid = 'channel_accounts'::regclass
    ) THEN
        ALTER TABLE channel_accounts
        ADD CONSTRAINT channel_accounts_id_client_unique
        UNIQUE (id, client_id);
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_channel_accounts_connection_mode
ON channel_accounts (
    connection_mode,
    status,
    client_id,
    id
);

-- ============================================================
-- Dashboard identities and tenant memberships
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_users (
    id BIGSERIAL PRIMARY KEY,
    email VARCHAR(320) NOT NULL,
    display_name VARCHAR(255),
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    email_verified_at TIMESTAMP WITH TIME ZONE,
    last_login_at TIMESTAMP WITH TIME ZONE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT platform_users_email_unique
        UNIQUE (email),

    CONSTRAINT platform_users_email_normalized_check
        CHECK (
            email = LOWER(BTRIM(email))
            AND BTRIM(email) <> ''
        ),

    CONSTRAINT platform_users_status_check
        CHECK (
            status IN (
                'invited',
                'active',
                'suspended',
                'disabled'
            )
        )
);

CREATE TABLE IF NOT EXISTS user_password_credentials (
    user_id BIGINT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    password_changed_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    failed_attempt_count INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT user_password_credentials_user_fkey
        FOREIGN KEY (user_id)
        REFERENCES platform_users(id)
        ON DELETE CASCADE,

    CONSTRAINT user_password_credentials_hash_check
        CHECK (LENGTH(BTRIM(password_hash)) >= 20),

    CONSTRAINT user_password_credentials_attempts_check
        CHECK (failed_attempt_count >= 0)
);

CREATE TABLE IF NOT EXISTS client_memberships (
    id BIGSERIAL PRIMARY KEY,
    client_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    role VARCHAR(30) NOT NULL DEFAULT 'owner',
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT client_memberships_client_fkey
        FOREIGN KEY (client_id)
        REFERENCES clients(id)
        ON DELETE CASCADE,

    CONSTRAINT client_memberships_user_fkey
        FOREIGN KEY (user_id)
        REFERENCES platform_users(id)
        ON DELETE CASCADE,

    CONSTRAINT client_memberships_client_user_unique
        UNIQUE (client_id, user_id),

    CONSTRAINT client_memberships_role_check
        CHECK (
            role IN (
                'owner',
                'admin',
                'agent',
                'analyst',
                'viewer'
            )
        ),

    CONSTRAINT client_memberships_status_check
        CHECK (
            status IN (
                'invited',
                'active',
                'suspended',
                'revoked'
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_client_memberships_user
ON client_memberships (
    user_id,
    status,
    client_id
);

CREATE INDEX IF NOT EXISTS idx_client_memberships_client
ON client_memberships (
    client_id,
    status,
    role
);

-- ============================================================
-- Operator-managed connector nodes
-- ============================================================

CREATE TABLE IF NOT EXISTS connector_nodes (
    id UUID PRIMARY KEY,
    node_name VARCHAR(255) NOT NULL,
    region VARCHAR(100) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'offline',
    version VARCHAR(100),
    public_key TEXT,
    credential_hash TEXT NOT NULL,
    max_sessions INTEGER NOT NULL DEFAULT 1,
    active_sessions INTEGER NOT NULL DEFAULT 0,
    reserved_sessions INTEGER NOT NULL DEFAULT 0,
    last_heartbeat_at TIMESTAMP WITH TIME ZONE,
    last_error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT connector_nodes_name_unique
        UNIQUE (node_name),

    CONSTRAINT connector_nodes_status_check
        CHECK (
            status IN (
                'registering',
                'online',
                'draining',
                'offline',
                'disabled',
                'error'
            )
        ),

    CONSTRAINT connector_nodes_capacity_check
        CHECK (
            max_sessions > 0
            AND active_sessions >= 0
            AND reserved_sessions >= 0
            AND active_sessions + reserved_sessions <= max_sessions
        ),

    CONSTRAINT connector_nodes_credential_hash_check
        CHECK (LENGTH(BTRIM(credential_hash)) >= 32)
);

CREATE INDEX IF NOT EXISTS idx_connector_nodes_scheduler
ON connector_nodes (
    status,
    region,
    active_sessions,
    reserved_sessions,
    max_sessions
);

CREATE INDEX IF NOT EXISTS idx_connector_nodes_heartbeat
ON connector_nodes (
    last_heartbeat_at
)
WHERE status IN ('registering', 'online', 'draining');

-- ============================================================
-- One connection state machine per channel account
-- ============================================================

CREATE TABLE IF NOT EXISTS channel_connections (
    channel_account_id BIGINT PRIMARY KEY,
    client_id BIGINT NOT NULL,
    connection_mode VARCHAR(30) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'created',
    connector_node_id UUID,
    assignment_generation BIGINT NOT NULL DEFAULT 0,
    session_locator VARCHAR(500),
    session_key_version INTEGER,
    connected_at TIMESTAMP WITH TIME ZONE,
    disconnected_at TIMESTAMP WITH TIME ZONE,
    last_seen_at TIMESTAMP WITH TIME ZONE,
    last_error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT channel_connections_account_client_fkey
        FOREIGN KEY (channel_account_id, client_id)
        REFERENCES channel_accounts(id, client_id)
        ON DELETE CASCADE,

    CONSTRAINT channel_connections_node_fkey
        FOREIGN KEY (connector_node_id)
        REFERENCES connector_nodes(id)
        ON DELETE SET NULL,

    CONSTRAINT channel_connections_mode_check
        CHECK (
            connection_mode IN (
                'local_web',
                'managed_web',
                'client_edge',
                'cloud_api'
            )
        ),

    CONSTRAINT channel_connections_status_check
        CHECK (
            status IN (
                'created',
                'waiting_for_node',
                'starting_browser',
                'waiting_for_pairing',
                'pairing_code_ready',
                'qr_ready',
                'authenticating',
                'connected',
                'reconnecting',
                'disconnected',
                'revoked',
                'failed'
            )
        ),

    CONSTRAINT channel_connections_assignment_check
        CHECK (assignment_generation >= 0),

    CONSTRAINT channel_connections_session_key_check
        CHECK (
            session_key_version IS NULL
            OR session_key_version > 0
        )
);

CREATE INDEX IF NOT EXISTS idx_channel_connections_scheduler
ON channel_connections (
    connection_mode,
    status,
    connector_node_id,
    updated_at
);

CREATE INDEX IF NOT EXISTS idx_channel_connections_client
ON channel_connections (
    client_id,
    status,
    channel_account_id
);

INSERT INTO channel_connections (
    channel_account_id,
    client_id,
    connection_mode,
    status,
    metadata
)
SELECT
    account.id,
    account.client_id,
    account.connection_mode,
    'created',
    jsonb_build_object(
        'migration',
        '003_managed_connector_control_plane'
    )
FROM channel_accounts account
ON CONFLICT (channel_account_id)
DO NOTHING;

-- ============================================================
-- Short-lived mobile pairing sessions
-- ============================================================

CREATE TABLE IF NOT EXISTS pairing_sessions (
    id UUID PRIMARY KEY,
    channel_account_id BIGINT NOT NULL,
    client_id BIGINT NOT NULL,
    connector_node_id UUID,
    initiated_by_user_id BIGINT,
    pairing_method VARCHAR(30) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'created',
    enrollment_token_hash CHAR(64) NOT NULL,
    artifact_ciphertext BYTEA,
    artifact_nonce BYTEA,
    artifact_key_version INTEGER,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    consumed_at TIMESTAMP WITH TIME ZONE,
    last_error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT pairing_sessions_account_client_fkey
        FOREIGN KEY (channel_account_id, client_id)
        REFERENCES channel_accounts(id, client_id)
        ON DELETE CASCADE,

    CONSTRAINT pairing_sessions_node_fkey
        FOREIGN KEY (connector_node_id)
        REFERENCES connector_nodes(id)
        ON DELETE SET NULL,

    CONSTRAINT pairing_sessions_user_fkey
        FOREIGN KEY (initiated_by_user_id)
        REFERENCES platform_users(id)
        ON DELETE SET NULL,

    CONSTRAINT pairing_sessions_token_hash_unique
        UNIQUE (enrollment_token_hash),

    CONSTRAINT pairing_sessions_method_check
        CHECK (
            pairing_method IN (
                'phone_code',
                'qr'
            )
        ),

    CONSTRAINT pairing_sessions_status_check
        CHECK (
            status IN (
                'created',
                'assigned',
                'waiting_for_artifact',
                'artifact_ready',
                'authenticating',
                'connected',
                'expired',
                'cancelled',
                'failed'
            )
        ),

    CONSTRAINT pairing_sessions_attempt_check
        CHECK (attempt_count >= 0),

    CONSTRAINT pairing_sessions_artifact_encryption_check
        CHECK (
            (
                artifact_ciphertext IS NULL
                AND artifact_nonce IS NULL
                AND artifact_key_version IS NULL
            )
            OR
            (
                artifact_ciphertext IS NOT NULL
                AND artifact_nonce IS NOT NULL
                AND artifact_key_version IS NOT NULL
                AND artifact_key_version > 0
            )
        ),

    CONSTRAINT pairing_sessions_expiry_check
        CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_pairing_sessions_account_status
ON pairing_sessions (
    channel_account_id,
    status,
    expires_at
);

CREATE INDEX IF NOT EXISTS idx_pairing_sessions_expiry
ON pairing_sessions (
    expires_at,
    status
)
WHERE status NOT IN (
    'connected',
    'expired',
    'cancelled',
    'failed'
);

-- ============================================================
-- Idempotent connector ingress journal
-- ============================================================

CREATE TABLE IF NOT EXISTS connector_events (
    id BIGSERIAL PRIMARY KEY,
    client_id BIGINT NOT NULL,
    channel_account_id BIGINT NOT NULL,
    connector_node_id UUID NOT NULL,
    external_event_id VARCHAR(500) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'accepted',
    received_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP WITH TIME ZONE,
    last_error TEXT,

    CONSTRAINT connector_events_account_client_fkey
        FOREIGN KEY (channel_account_id, client_id)
        REFERENCES channel_accounts(id, client_id)
        ON DELETE CASCADE,

    CONSTRAINT connector_events_node_fkey
        FOREIGN KEY (connector_node_id)
        REFERENCES connector_nodes(id)
        ON DELETE RESTRICT,

    CONSTRAINT connector_events_idempotency_unique
        UNIQUE (channel_account_id, external_event_id),

    CONSTRAINT connector_events_status_check
        CHECK (
            status IN (
                'accepted',
                'processing',
                'processed',
                'rejected',
                'failed'
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_connector_events_processing
ON connector_events (
    status,
    received_at,
    id
)
WHERE status IN ('accepted', 'failed');

CREATE INDEX IF NOT EXISTS idx_connector_events_client
ON connector_events (
    client_id,
    channel_account_id,
    received_at
);

-- ============================================================
-- Durable commands
-- ============================================================

CREATE TABLE IF NOT EXISTS connector_commands (
    id BIGSERIAL PRIMARY KEY,
    client_id BIGINT NOT NULL,
    channel_account_id BIGINT NOT NULL,
    connector_node_id UUID NOT NULL,
    reply_job_id BIGINT,
    command_type VARCHAR(50) NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    available_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    claimed_at TIMESTAMP WITH TIME ZONE,
    claim_expires_at TIMESTAMP WITH TIME ZONE,
    claim_token UUID,
    acknowledged_at TIMESTAMP WITH TIME ZONE,
    external_message_id VARCHAR(500),
    last_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT connector_commands_account_client_fkey
        FOREIGN KEY (channel_account_id, client_id)
        REFERENCES channel_accounts(id, client_id)
        ON DELETE CASCADE,

    CONSTRAINT connector_commands_node_fkey
        FOREIGN KEY (connector_node_id)
        REFERENCES connector_nodes(id)
        ON DELETE RESTRICT,

    CONSTRAINT connector_commands_reply_job_fkey
        FOREIGN KEY (reply_job_id)
        REFERENCES message_reply_jobs(id)
        ON DELETE RESTRICT,

    CONSTRAINT connector_commands_idempotency_unique
        UNIQUE (channel_account_id, idempotency_key),

    CONSTRAINT connector_commands_reply_job_unique
        UNIQUE (reply_job_id),

    CONSTRAINT connector_commands_type_check
        CHECK (
            command_type IN (
                'start_pairing',
                'cancel_pairing',
                'send_message',
                'restart_session',
                'disconnect_session',
                'health_check'
            )
        ),

    CONSTRAINT connector_commands_status_check
        CHECK (
            status IN (
                'pending',
                'claimed',
                'succeeded',
                'failed',
                'cancelled',
                'unknown'
            )
        ),

    CONSTRAINT connector_commands_attempt_check
        CHECK (attempt_count >= 0),

    CONSTRAINT connector_commands_claim_state_check
        CHECK (
            (
                status = 'claimed'
                AND claimed_at IS NOT NULL
                AND claim_expires_at IS NOT NULL
                AND claim_token IS NOT NULL
            )
            OR
            (
                status <> 'claimed'
                AND claim_expires_at IS NULL
                AND claim_token IS NULL
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_connector_commands_claim
ON connector_commands (
    connector_node_id,
    status,
    available_at,
    id
)
WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_connector_commands_claim_expiry
ON connector_commands (
    claim_expires_at
)
WHERE status = 'claimed';

CREATE INDEX IF NOT EXISTS idx_connector_commands_client
ON connector_commands (
    client_id,
    channel_account_id,
    created_at
);

-- ============================================================
-- Security/audit trail
-- ============================================================

CREATE TABLE IF NOT EXISTS control_plane_audit_log (
    id BIGSERIAL PRIMARY KEY,
    client_id BIGINT,
    actor_user_id BIGINT,
    actor_node_id UUID,
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(100) NOT NULL,
    resource_id VARCHAR(255),
    request_id UUID,
    ip_address INET,
    user_agent TEXT,
    before_state JSONB,
    after_state JSONB,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT control_plane_audit_client_fkey
        FOREIGN KEY (client_id)
        REFERENCES clients(id)
        ON DELETE SET NULL,

    CONSTRAINT control_plane_audit_user_fkey
        FOREIGN KEY (actor_user_id)
        REFERENCES platform_users(id)
        ON DELETE SET NULL,

    CONSTRAINT control_plane_audit_node_fkey
        FOREIGN KEY (actor_node_id)
        REFERENCES connector_nodes(id)
        ON DELETE SET NULL,

    CONSTRAINT control_plane_audit_actor_check
        CHECK (
            actor_user_id IS NOT NULL
            OR actor_node_id IS NOT NULL
        ),

    CONSTRAINT control_plane_audit_action_check
        CHECK (BTRIM(action) <> ''),

    CONSTRAINT control_plane_audit_resource_check
        CHECK (BTRIM(resource_type) <> '')
);

CREATE INDEX IF NOT EXISTS idx_control_plane_audit_client
ON control_plane_audit_log (
    client_id,
    created_at,
    id
);

CREATE INDEX IF NOT EXISTS idx_control_plane_audit_actor_user
ON control_plane_audit_log (
    actor_user_id,
    created_at
)
WHERE actor_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_control_plane_audit_actor_node
ON control_plane_audit_log (
    actor_node_id,
    created_at
)
WHERE actor_node_id IS NOT NULL;

-- ============================================================
-- Post-migration invariants
-- ============================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM channel_connections connection
        JOIN channel_accounts account
          ON account.id = connection.channel_account_id
        WHERE connection.client_id <> account.client_id
    ) THEN
        RAISE EXCEPTION
            'Migration invariant failed: cross-tenant channel connection';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pairing_sessions pairing
        JOIN channel_accounts account
          ON account.id = pairing.channel_account_id
        WHERE pairing.client_id <> account.client_id
    ) THEN
        RAISE EXCEPTION
            'Migration invariant failed: cross-tenant pairing session';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM connector_events event
        JOIN channel_accounts account
          ON account.id = event.channel_account_id
        WHERE event.client_id <> account.client_id
    ) THEN
        RAISE EXCEPTION
            'Migration invariant failed: cross-tenant connector event';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM connector_commands command
        JOIN channel_accounts account
          ON account.id = command.channel_account_id
        WHERE command.client_id <> account.client_id
    ) THEN
        RAISE EXCEPTION
            'Migration invariant failed: cross-tenant connector command';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM channel_accounts account
        LEFT JOIN channel_connections connection
          ON connection.channel_account_id = account.id
        WHERE connection.channel_account_id IS NULL
    ) THEN
        RAISE EXCEPTION
            'Migration invariant failed: channel connection backfill missing';
    END IF;
END;
$$;

COMMIT;