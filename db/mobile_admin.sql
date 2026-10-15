-- OmniFlow Mobile Admin - Neon tables (§275)
-- OPTIONAL. The Control Plane creates these automatically on the first
-- mobile-admin call (lazy DDL, CREATE TABLE IF NOT EXISTS), so you normally
-- do NOT need to run this file. It is here if you prefer to create the
-- tables by hand, or to review the exact schema.
--
-- Auth for the Admin app lives HERE (Neon) - the same DB the Control Plane
-- already uses via DB_HOST. There is NO Supabase in the Control Plane.
--
-- The admin ACCOUNT is created with the one-time bootstrap endpoint
-- (protected by X-Omniflow-Key), because the password must be hashed by the
-- server. Do NOT insert an account by hand with a plaintext password:
--
--   curl -X POST https://omniflow-backend.vercel.app/api/v1/mobile/admin/bootstrap \
--     -H "X-Omniflow-Key: <OMNIFLOW_SERVICE_KEY>" \
--     -H "Content-Type: application/json" \
--     -d '{"email":"owner@omniflow.pk","password":"<a long strong password>","name":"Owner"}'

CREATE TABLE IF NOT EXISTS mobile_admins (
    id            BIGSERIAL PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name  TEXT,
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mobile_admin_sessions (
    id                 BIGSERIAL PRIMARY KEY,
    admin_id           BIGINT NOT NULL REFERENCES mobile_admins (id) ON DELETE CASCADE,
    access_hash        TEXT NOT NULL UNIQUE,
    refresh_hash       TEXT NOT NULL UNIQUE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at         TIMESTAMPTZ NOT NULL,
    refresh_expires_at TIMESTAMPTZ NOT NULL,
    last_seen_at       TIMESTAMPTZ,
    revoked_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS mobile_admin_sessions_refresh_idx
    ON mobile_admin_sessions (refresh_hash);
