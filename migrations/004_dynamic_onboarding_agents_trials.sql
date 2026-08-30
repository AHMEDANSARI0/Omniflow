BEGIN;

-- ============================================================
-- Configurable, versioned AI agents
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_agents (
    id UUID PRIMARY KEY,
    client_id BIGINT NOT NULL,
    agent_key VARCHAR(100) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT ai_agents_client_fkey
        FOREIGN KEY (client_id)
        REFERENCES clients(id)
        ON DELETE CASCADE,

    CONSTRAINT ai_agents_client_key_unique
        UNIQUE (client_id, agent_key),

    CONSTRAINT ai_agents_id_client_unique
        UNIQUE (id, client_id),

    CONSTRAINT ai_agents_key_check
        CHECK (
            agent_key = LOWER(BTRIM(agent_key))
            AND BTRIM(agent_key) <> ''
        ),

    CONSTRAINT ai_agents_name_check
        CHECK (
            BTRIM(display_name) <> ''
        ),

    CONSTRAINT ai_agents_status_check
        CHECK (
            status IN (
                'draft',
                'active',
                'paused',
                'archived'
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_ai_agents_client_status
ON ai_agents (
    client_id,
    status,
    agent_key
);

CREATE TABLE IF NOT EXISTS ai_agent_versions (
    id BIGSERIAL PRIMARY KEY,
    agent_id UUID NOT NULL,
    client_id BIGINT NOT NULL,
    version_number INTEGER NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    system_instruction TEXT NOT NULL,

    business_profile JSONB
        NOT NULL DEFAULT '{}'::jsonb,

    language_policy JSONB
        NOT NULL DEFAULT '{}'::jsonb,

    tone_policy JSONB
        NOT NULL DEFAULT '{}'::jsonb,

    knowledge_config JSONB
        NOT NULL DEFAULT '{}'::jsonb,

    qualification_config JSONB
        NOT NULL DEFAULT '{}'::jsonb,

    workflow_config JSONB
        NOT NULL DEFAULT '{}'::jsonb,

    fallback_config JSONB
        NOT NULL DEFAULT '{}'::jsonb,

    handoff_config JSONB
        NOT NULL DEFAULT '{}'::jsonb,

    tool_config JSONB
        NOT NULL DEFAULT '{}'::jsonb,

    created_by_user_id BIGINT,

    created_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT ai_agent_versions_agent_client_fkey
        FOREIGN KEY (
            agent_id,
            client_id
        )
        REFERENCES ai_agents(
            id,
            client_id
        )
        ON DELETE CASCADE,

    CONSTRAINT ai_agent_versions_creator_fkey
        FOREIGN KEY (created_by_user_id)
        REFERENCES platform_users(id)
        ON DELETE SET NULL,

    CONSTRAINT ai_agent_versions_number_unique
        UNIQUE (
            agent_id,
            version_number
        ),

    CONSTRAINT ai_agent_versions_id_agent_client_unique
        UNIQUE (
            id,
            agent_id,
            client_id
        ),

    CONSTRAINT ai_agent_versions_number_check
        CHECK (
            version_number > 0
        ),

    CONSTRAINT ai_agent_versions_instruction_check
        CHECK (
            BTRIM(system_instruction) <> ''
        ),

    CONSTRAINT ai_agent_versions_status_check
        CHECK (
            status IN (
                'draft',
                'active',
                'archived'
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_versions_agent
ON ai_agent_versions (
    client_id,
    agent_id,
    version_number DESC
);

CREATE TABLE IF NOT EXISTS channel_agent_assignments (
    id BIGSERIAL PRIMARY KEY,
    channel_account_id BIGINT NOT NULL,
    client_id BIGINT NOT NULL,
    agent_id UUID NOT NULL,
    agent_version_id BIGINT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    assigned_by_user_id BIGINT,

    assigned_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    unassigned_at TIMESTAMP WITH TIME ZONE,

    metadata JSONB
        NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT channel_agent_assignments_account_client_fkey
        FOREIGN KEY (
            channel_account_id,
            client_id
        )
        REFERENCES channel_accounts(
            id,
            client_id
        )
        ON DELETE CASCADE,

    CONSTRAINT channel_agent_assignments_agent_client_fkey
        FOREIGN KEY (
            agent_id,
            client_id
        )
        REFERENCES ai_agents(
            id,
            client_id
        )
        ON DELETE RESTRICT,

    CONSTRAINT channel_agent_assignments_version_fkey
        FOREIGN KEY (
            agent_version_id,
            agent_id,
            client_id
        )
        REFERENCES ai_agent_versions(
            id,
            agent_id,
            client_id
        )
        ON DELETE RESTRICT,

    CONSTRAINT channel_agent_assignments_user_fkey
        FOREIGN KEY (assigned_by_user_id)
        REFERENCES platform_users(id)
        ON DELETE SET NULL,

    CONSTRAINT channel_agent_assignments_status_check
        CHECK (
            status IN (
                'active',
                'inactive'
            )
        ),

    CONSTRAINT channel_agent_assignments_time_check
        CHECK (
            (
                status = 'active'
                AND unassigned_at IS NULL
            )
            OR
            (
                status = 'inactive'
                AND unassigned_at IS NOT NULL
            )
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_agent_active
ON channel_agent_assignments (
    channel_account_id
)
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_channel_agent_assignments_client
ON channel_agent_assignments (
    client_id,
    status,
    channel_account_id
);

-- ============================================================
-- Trial limits and usage counters
-- ============================================================

CREATE TABLE IF NOT EXISTS client_trial_entitlements (
    client_id BIGINT PRIMARY KEY,

    plan_key VARCHAR(100)
        NOT NULL DEFAULT 'managed_web_trial',

    status VARCHAR(20)
        NOT NULL DEFAULT 'trial',

    starts_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,

    max_channel_accounts INTEGER
        NOT NULL DEFAULT 1,

    max_managed_sessions INTEGER
        NOT NULL DEFAULT 1,

    max_inbound_messages INTEGER
        NOT NULL DEFAULT 500,

    max_ai_calls INTEGER
        NOT NULL DEFAULT 500,

    max_outbound_messages INTEGER
        NOT NULL DEFAULT 500,

    metadata JSONB
        NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT client_trial_entitlements_client_fkey
        FOREIGN KEY (client_id)
        REFERENCES clients(id)
        ON DELETE CASCADE,

    CONSTRAINT client_trial_entitlements_status_check
        CHECK (
            status IN (
                'trial',
                'active',
                'paused',
                'expired',
                'cancelled'
            )
        ),

    CONSTRAINT client_trial_entitlements_expiry_check
        CHECK (
            expires_at > starts_at
        ),

    CONSTRAINT client_trial_entitlements_limits_check
        CHECK (
            max_channel_accounts > 0
            AND max_managed_sessions > 0
            AND max_inbound_messages >= 0
            AND max_ai_calls >= 0
            AND max_outbound_messages >= 0
        )
);

CREATE INDEX IF NOT EXISTS idx_client_trial_expiry
ON client_trial_entitlements (
    status,
    expires_at,
    client_id
);

CREATE TABLE IF NOT EXISTS client_usage_counters (
    id BIGSERIAL PRIMARY KEY,
    client_id BIGINT NOT NULL,

    period_start TIMESTAMP WITH TIME ZONE
        NOT NULL,

    period_end TIMESTAMP WITH TIME ZONE
        NOT NULL,

    inbound_messages BIGINT
        NOT NULL DEFAULT 0,

    ai_calls BIGINT
        NOT NULL DEFAULT 0,

    outbound_messages BIGINT
        NOT NULL DEFAULT 0,

    audio_seconds NUMERIC(14, 3)
        NOT NULL DEFAULT 0,

    estimated_cost_usd NUMERIC(14, 6)
        NOT NULL DEFAULT 0,

    updated_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT client_usage_counters_client_fkey
        FOREIGN KEY (client_id)
        REFERENCES clients(id)
        ON DELETE CASCADE,

    CONSTRAINT client_usage_counters_period_unique
        UNIQUE (
            client_id,
            period_start,
            period_end
        ),

    CONSTRAINT client_usage_counters_period_check
        CHECK (
            period_end > period_start
        ),

    CONSTRAINT client_usage_counters_nonnegative_check
        CHECK (
            inbound_messages >= 0
            AND ai_calls >= 0
            AND outbound_messages >= 0
            AND audio_seconds >= 0
            AND estimated_cost_usd >= 0
        )
);

CREATE INDEX IF NOT EXISTS idx_client_usage_period
ON client_usage_counters (
    client_id,
    period_end DESC
);

-- ============================================================
-- Idempotent API-level onboarding journal
-- ============================================================

CREATE TABLE IF NOT EXISTS onboarding_requests (
    id UUID PRIMARY KEY,

    api_version VARCHAR(20)
        NOT NULL DEFAULT 'v1',

    idempotency_key VARCHAR(255) NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,

    status VARCHAR(20)
        NOT NULL DEFAULT 'processing',

    client_id BIGINT,
    owner_user_id BIGINT,
    channel_account_id BIGINT,
    agent_id UUID,
    last_error TEXT,

    created_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    completed_at TIMESTAMP WITH TIME ZONE,

    updated_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT onboarding_requests_idempotency_unique
        UNIQUE (idempotency_key),

    CONSTRAINT onboarding_requests_client_fkey
        FOREIGN KEY (client_id)
        REFERENCES clients(id)
        ON DELETE RESTRICT,

    CONSTRAINT onboarding_requests_user_fkey
        FOREIGN KEY (owner_user_id)
        REFERENCES platform_users(id)
        ON DELETE RESTRICT,

    CONSTRAINT onboarding_requests_channel_fkey
        FOREIGN KEY (channel_account_id)
        REFERENCES channel_accounts(id)
        ON DELETE RESTRICT,

    CONSTRAINT onboarding_requests_agent_fkey
        FOREIGN KEY (agent_id)
        REFERENCES ai_agents(id)
        ON DELETE RESTRICT,

    CONSTRAINT onboarding_requests_status_check
        CHECK (
            status IN (
                'processing',
                'completed',
                'failed'
            )
        ),

    CONSTRAINT onboarding_requests_completion_check
        CHECK (
            status <> 'completed'
            OR (
                client_id IS NOT NULL
                AND owner_user_id IS NOT NULL
                AND channel_account_id IS NOT NULL
                AND agent_id IS NOT NULL
                AND completed_at IS NOT NULL
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_onboarding_requests_status
ON onboarding_requests (
    status,
    created_at,
    id
);

-- ============================================================
-- Post-migration tenant invariants
-- ============================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM channel_agent_assignments assignment
        JOIN channel_accounts account
          ON account.id = assignment.channel_account_id
        WHERE assignment.client_id <> account.client_id
    ) THEN
        RAISE EXCEPTION 'Migration invariant failed: cross-tenant channel agent assignment';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM ai_agent_versions version
        JOIN ai_agents agent
          ON agent.id = version.agent_id
        WHERE version.client_id <> agent.client_id
    ) THEN
        RAISE EXCEPTION 'Migration invariant failed: cross-tenant agent version';
    END IF;
END;
$$;

COMMIT;
