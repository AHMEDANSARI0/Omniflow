-- ============================================================================
-- OmniFlow WEBSITE -> NEON schema (§276 website migration)
-- Replaces the website's Supabase tables with Neon (the SAME single database
-- the Control Plane uses via DB_HOST). After this, the website has ZERO
-- Supabase: admin login, the marketing CMS and leads all live here.
--
-- HOW TO APPLY: run this once against your Neon database (Neon console -> SQL
-- Editor, paste, Run). It is idempotent (IF NOT EXISTS / OR REPLACE / ON
-- CONFLICT DO NOTHING), so re-running is safe.
--
-- NOTE: the legacy bot-ingest tables (api_keys, bot_settings, business_profiles,
-- conversations, conversation_messages) are intentionally NOT created here -
-- the WhatsApp bot talks to the Control Plane (Neon) directly, and the website
-- /api/bot/* Supabase routes were legacy. Business/conversation data already
-- lives in the Control Plane's Neon tables.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. ADMIN AUTH (replaces Supabase Auth + the `profiles` role table)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,           -- scrypt hash, set by the migrate/bootstrap tooling
    role          TEXT NOT NULL DEFAULT 'admin',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_sessions (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,      -- sha256 of the opaque session cookie
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ,
    revoked_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS admin_sessions_token_idx ON admin_sessions (token_hash);

-- The website's role gate reads `.from("profiles").select("role").eq("id", user.id)`.
-- A read-only view over admin_users keeps that call working with no code change.
CREATE OR REPLACE VIEW profiles AS
    SELECT id, email, role, created_at FROM admin_users;

-- ---------------------------------------------------------------------------
-- 2. MARKETING CMS
-- ---------------------------------------------------------------------------
-- site_content: one JSON row per editable section (hero, faq, features, ...).
CREATE TABLE IF NOT EXISTS site_content (
    section    TEXT PRIMARY KEY,
    data       JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- blog_posts: mirrors the previous Supabase schema (db/blog_posts.sql) exactly,
-- minus the Supabase RLS policies (the website now enforces access in code).
CREATE TABLE IF NOT EXISTS blog_posts (
    id              BIGSERIAL PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    excerpt         TEXT NOT NULL DEFAULT '',
    category        TEXT NOT NULL DEFAULT 'AI Automation',
    author          TEXT NOT NULL DEFAULT 'OmniFlow Team',
    reading_minutes INT NOT NULL DEFAULT 4,
    content         TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'draft',
    published_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS blog_posts_published_idx
    ON blog_posts (status, published_at DESC);

-- site_settings: single row (id = 1) with the site-wide SEO metadata.
CREATE TABLE IF NOT EXISTS site_settings (
    id               INT PRIMARY KEY DEFAULT 1,
    meta_title       TEXT NOT NULL DEFAULT '',
    meta_description TEXT NOT NULL DEFAULT '',
    keywords         TEXT NOT NULL DEFAULT '',
    og_title         TEXT NOT NULL DEFAULT '',
    og_description   TEXT NOT NULL DEFAULT '',
    site_url         TEXT NOT NULL DEFAULT '',
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT site_settings_single_row CHECK (id = 1)
);

-- Seed the single settings row so `.eq("id", 1)` reads/updates resolve.
INSERT INTO site_settings (id, meta_title, meta_description, keywords,
                           og_title, og_description, site_url)
VALUES (1, '', '', '', '', '', '')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. LEADS (marketing early-access form)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
    id         BIGSERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL UNIQUE,
    company    TEXT,
    status     TEXT NOT NULL DEFAULT 'new',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leads_created_idx ON leads (created_at DESC);
