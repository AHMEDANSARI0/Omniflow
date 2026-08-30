\set ON_ERROR_STOP on

BEGIN;

-- ============================================================
-- Safety guards
-- ============================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM contacts
        WHERE whatsapp_account_id IS NULL
    ) THEN
        RAISE EXCEPTION
            'Migration blocked: unscoped contacts still exist';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM whatsapp_accounts
        WHERE phone_number IS NULL
           OR BTRIM(phone_number) = ''
    ) THEN
        RAISE EXCEPTION
            'Migration blocked: channel account identifier is missing';
    END IF;
END;
$$;

-- ============================================================
-- whatsapp_accounts -> channel_accounts
-- ============================================================

ALTER TABLE whatsapp_accounts
RENAME TO channel_accounts;

ALTER SEQUENCE whatsapp_accounts_id_seq
RENAME TO channel_accounts_id_seq;

ALTER TABLE channel_accounts
RENAME CONSTRAINT whatsapp_accounts_pkey
TO channel_accounts_pkey;

ALTER TABLE channel_accounts
RENAME CONSTRAINT whatsapp_accounts_client_id_fkey
TO channel_accounts_client_id_fkey;

ALTER TABLE channel_accounts
RENAME COLUMN phone_number
TO external_account_id;

ALTER TABLE channel_accounts
ADD COLUMN platform VARCHAR(30)
NOT NULL DEFAULT 'whatsapp';

ALTER TABLE channel_accounts
ALTER COLUMN platform DROP DEFAULT;

ALTER TABLE channel_accounts
ALTER COLUMN external_account_id SET NOT NULL;

ALTER TABLE channel_accounts
ADD COLUMN metadata JSONB
NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE channel_accounts
ADD CONSTRAINT channel_accounts_platform_check
CHECK (
    platform = LOWER(platform)
    AND BTRIM(platform) <> ''
);

ALTER TABLE channel_accounts
ADD CONSTRAINT channel_accounts_status_check
CHECK (
    status IN (
        'active',
        'inactive',
        'pending',
        'disconnected'
    )
);

ALTER TABLE channel_accounts
ADD CONSTRAINT channel_accounts_platform_external_unique
UNIQUE (
    platform,
    external_account_id
);

CREATE INDEX idx_channel_accounts_client_status
ON channel_accounts (
    client_id,
    status,
    platform
);

-- ============================================================
-- contacts -> channel_contacts
-- ============================================================

ALTER TABLE contacts
RENAME TO channel_contacts;

ALTER SEQUENCE contacts_id_seq
RENAME TO channel_contacts_id_seq;

ALTER TABLE channel_contacts
RENAME CONSTRAINT contacts_pkey
TO channel_contacts_pkey;

ALTER TABLE channel_contacts
RENAME CONSTRAINT contacts_whatsapp_phone_unique
TO channel_contacts_account_user_unique;

ALTER TABLE channel_contacts
RENAME CONSTRAINT contacts_whatsapp_account_fk
TO channel_contacts_channel_account_fk;

ALTER INDEX idx_contacts_phone_number
RENAME TO idx_channel_contacts_external_user_id;

ALTER TABLE channel_contacts
RENAME COLUMN phone_number
TO external_user_id;

ALTER TABLE channel_contacts
RENAME COLUMN name
TO display_name;

ALTER TABLE channel_contacts
RENAME COLUMN whatsapp_account_id
TO channel_account_id;

ALTER TABLE channel_contacts
ALTER COLUMN external_user_id TYPE VARCHAR(255);

ALTER TABLE channel_contacts
ALTER COLUMN channel_account_id SET NOT NULL;

ALTER TABLE channel_contacts
ADD COLUMN customer_id BIGINT;

ALTER TABLE channel_contacts
ADD COLUMN username VARCHAR(255);

ALTER TABLE channel_contacts
ADD COLUMN identity_type VARCHAR(30)
NOT NULL DEFAULT 'platform_user_id';

ALTER TABLE channel_contacts
ADD COLUMN status VARCHAR(20)
NOT NULL DEFAULT 'active';

ALTER TABLE channel_contacts
ADD COLUMN metadata JSONB
NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE channel_contacts
ADD CONSTRAINT channel_contacts_identity_type_check
CHECK (
    identity_type IN (
        'platform_user_id',
        'phone_number',
        'username',
        'email',
        'legacy'
    )
);

ALTER TABLE channel_contacts
ADD CONSTRAINT channel_contacts_status_check
CHECK (
    status IN (
        'active',
        'inactive',
        'blocked',
        'legacy'
    )
);

-- ============================================================
-- Canonical cross-platform customers
-- ============================================================

CREATE TABLE customers (
    id BIGSERIAL PRIMARY KEY,

    client_id BIGINT NOT NULL,

    display_name VARCHAR(255),
    email VARCHAR(255),
    phone_number VARCHAR(50),

    status VARCHAR(20)
        NOT NULL DEFAULT 'active',

    metadata JSONB
        NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMP WITHOUT TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMP WITHOUT TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT customers_client_id_fkey
        FOREIGN KEY (client_id)
        REFERENCES clients(id)
        ON DELETE CASCADE,

    CONSTRAINT customers_status_check
        CHECK (
            status IN (
                'active',
                'inactive',
                'blocked',
                'merged'
            )
        )
);

CREATE INDEX idx_customers_client_id
ON customers (
    client_id,
    id
);

CREATE INDEX idx_customers_client_status
ON customers (
    client_id,
    status
);

-- One canonical customer is created for every existing channel identity.
-- Identities can be explicitly linked to the same customer later.
CREATE TEMP TABLE channel_contact_customer_map (
    channel_contact_id BIGINT PRIMARY KEY,
    customer_id BIGINT NOT NULL UNIQUE
) ON COMMIT DROP;

INSERT INTO channel_contact_customer_map (
    channel_contact_id,
    customer_id
)
SELECT
    cc.id,
    nextval('customers_id_seq'::regclass)
FROM channel_contacts cc
ORDER BY cc.id;

INSERT INTO customers (
    id,
    client_id,
    display_name,
    status,
    metadata,
    created_at,
    updated_at
)
SELECT
    mapping.customer_id,
    ca.client_id,
    cc.display_name,
    'active',
    '{}'::jsonb,
    cc.created_at,
    cc.updated_at
FROM channel_contact_customer_map mapping
JOIN channel_contacts cc
  ON cc.id = mapping.channel_contact_id
JOIN channel_accounts ca
  ON ca.id = cc.channel_account_id;

UPDATE channel_contacts cc
SET customer_id = mapping.customer_id
FROM channel_contact_customer_map mapping
WHERE mapping.channel_contact_id = cc.id;

ALTER TABLE channel_contacts
ALTER COLUMN customer_id SET NOT NULL;

ALTER TABLE channel_contacts
ADD CONSTRAINT channel_contacts_customer_id_fkey
FOREIGN KEY (customer_id)
REFERENCES customers(id)
ON DELETE RESTRICT;

CREATE INDEX idx_channel_contacts_customer_id
ON channel_contacts (
    customer_id,
    id
);

CREATE INDEX idx_channel_contacts_channel_account
ON channel_contacts (
    channel_account_id,
    id
);

-- ============================================================
-- Generic conversations
-- ============================================================

ALTER TABLE conversations
RENAME COLUMN contact_id
TO channel_contact_id;

ALTER TABLE conversations
RENAME CONSTRAINT conversations_contact_id_fkey
TO conversations_channel_contact_id_fkey;

ALTER TABLE conversations
RENAME CONSTRAINT conversations_contact_unique
TO conversations_channel_contact_unique;

ALTER TABLE conversations
ADD COLUMN status VARCHAR(20)
NOT NULL DEFAULT 'active';

ALTER TABLE conversations
ADD COLUMN metadata JSONB
NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE conversations
ADD CONSTRAINT conversations_status_check
CHECK (
    status IN (
        'active',
        'closed',
        'archived'
    )
);

-- ============================================================
-- Generic messages
-- ============================================================

ALTER TABLE messages
RENAME COLUMN message
TO content;

ALTER TABLE messages
RENAME COLUMN whatsapp_message_id
TO external_message_id;

ALTER INDEX idx_messages_unique_whatsapp_message
RENAME TO idx_messages_unique_external_message;

ALTER TABLE messages
ADD COLUMN direction VARCHAR(20);

UPDATE messages
SET direction = CASE
    WHEN role = 'user' THEN 'inbound'
    WHEN role = 'assistant' THEN 'outbound'
    ELSE 'internal'
END;

ALTER TABLE messages
ALTER COLUMN direction SET NOT NULL;

ALTER TABLE messages
ADD COLUMN message_type VARCHAR(30)
NOT NULL DEFAULT 'text';

ALTER TABLE messages
ADD COLUMN metadata JSONB
NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE messages
ADD CONSTRAINT messages_direction_check
CHECK (
    direction IN (
        'inbound',
        'outbound',
        'internal'
    )
);

ALTER TABLE messages
ADD CONSTRAINT messages_type_check
CHECK (
    message_type IN (
        'text',
        'audio',
        'image',
        'video',
        'document',
        'location',
        'contact',
        'interactive',
        'event'
    )
);

-- ============================================================
-- Generic durable reply jobs
-- ============================================================

ALTER TABLE message_reply_jobs
RENAME COLUMN outbound_whatsapp_message_id
TO outbound_external_message_id;

-- ============================================================
-- Rename remaining legacy-named indexes where applicable
-- ============================================================

-- The unique constraint was renamed above; its indexed columns now follow
-- channel_account_id and external_user_id automatically.

-- ============================================================
-- Post-migration invariants
-- ============================================================

DO $$
DECLARE
    channel_contact_count BIGINT;
    customer_count BIGINT;
BEGIN
    SELECT COUNT(*)
    INTO channel_contact_count
    FROM channel_contacts;

    SELECT COUNT(*)
    INTO customer_count
    FROM customers;

    IF channel_contact_count <> customer_count THEN
        RAISE EXCEPTION
            'Migration invariant failed: % channel contacts but % customers',
            channel_contact_count,
            customer_count;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM channel_contacts
        WHERE customer_id IS NULL
           OR channel_account_id IS NULL
    ) THEN
        RAISE EXCEPTION
            'Migration invariant failed: unscoped channel identity exists';
    END IF;
END;
$$;

COMMIT;
