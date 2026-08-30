\set ON_ERROR_STOP on

BEGIN;

-- ============================================================
-- Distributed channel-account worker leases
-- ============================================================
-- One channel account may be owned by only one live worker across all hosts.
-- Rows are retained after release for operational visibility. An expired lease
-- may be atomically taken over by another worker.

CREATE TABLE IF NOT EXISTS channel_account_leases (
    channel_account_id BIGINT PRIMARY KEY,

    owner_token UUID,
    worker_id VARCHAR(255),

    acquired_at TIMESTAMP WITH TIME ZONE,
    heartbeat_at TIMESTAMP WITH TIME ZONE,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    released_at TIMESTAMP WITH TIME ZONE,

    last_error TEXT,

    created_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT channel_account_leases_account_fkey
        FOREIGN KEY (channel_account_id)
        REFERENCES channel_accounts(id)
        ON DELETE CASCADE,

    CONSTRAINT channel_account_leases_owner_state_check
        CHECK (
            (
                owner_token IS NULL
                AND worker_id IS NULL
                AND lease_expires_at IS NULL
            )
            OR
            (
                owner_token IS NOT NULL
                AND worker_id IS NOT NULL
                AND lease_expires_at IS NOT NULL
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_channel_account_leases_expiry
ON channel_account_leases (
    lease_expires_at
)
WHERE owner_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_channel_account_leases_worker
ON channel_account_leases (
    worker_id,
    channel_account_id
)
WHERE owner_token IS NOT NULL;

-- ============================================================
-- Post-migration invariants
-- ============================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM channel_account_leases lease
        LEFT JOIN channel_accounts account
          ON account.id = lease.channel_account_id
        WHERE account.id IS NULL
    ) THEN
        RAISE EXCEPTION
            'Migration invariant failed: orphan channel-account lease exists';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM channel_account_leases
        WHERE (
            owner_token IS NULL
            AND (
                worker_id IS NOT NULL
                OR lease_expires_at IS NOT NULL
            )
        )
        OR (
            owner_token IS NOT NULL
            AND (
                worker_id IS NULL
                OR lease_expires_at IS NULL
            )
        )
    ) THEN
        RAISE EXCEPTION
            'Migration invariant failed: inconsistent lease ownership state';
    END IF;
END;
$$;

COMMIT;
