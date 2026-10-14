/* ===========================================================================
   OmniFlow WEBSITE -> NEON schema  (§276 website migration — revision §276r2)

   Replaces the website's Supabase tables with Neon (the SAME single database
   the Control Plane uses). After this, the website has ZERO Supabase: admin
   login, the marketing CMS, blog, SEO settings and leads all live here.

   HOW TO APPLY (once):
     Neon console -> your project -> SQL Editor -> paste this WHOLE file ->
     press RUN (or Ctrl/Cmd+Enter).  NEVER use the EXPLAIN button on this
     file: EXPLAIN only works for SELECT/INSERT/UPDATE/DELETE and wrapping a
     CREATE TABLE in EXPLAIN fails with "syntax error at or near UUID".
     Works the same via psql:  psql "<DATABASE_URL>" -f db/website_neon.sql

   Idempotent: IF NOT EXISTS / OR REPLACE / ON CONFLICT DO NOTHING — running
   it again is always safe.

   §276r2 note: block comments only (no "--" line comments) so the file also
   survives editors/tools that reflow or collapse lines; comment text moved
   out of the column lists. The DDL itself is unchanged from §276.

   The legacy bot-ingest tables (api_keys, bot_settings, business_profiles,
   conversations, conversation_messages) are intentionally NOT created here:
   the WhatsApp bot talks to the Control Plane directly, and the website
   bot-ingest API routes now answer 410 Gone.
   =========================================================================== */

/* ---------------------------------------------------------------------------
   1. ADMIN AUTH (replaces Supabase Auth + the `profiles` role table)
   password_hash holds a scrypt hash (scrypt$salt$hex) written by the
   migrate/bootstrap tooling — never a plaintext password.
   --------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS admin_users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'admin',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* admin_sessions.token_hash stores the sha256 of the opaque session cookie
   (of_admin_session); the raw token never touches the database. */
CREATE TABLE IF NOT EXISTS admin_sessions (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ,
    revoked_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS admin_sessions_token_idx ON admin_sessions (token_hash);

/* The website's role gate reads .from("profiles").select("role").eq("id", …).
   A read-only view over admin_users keeps that call working unchanged. */
CREATE OR REPLACE VIEW profiles AS
    SELECT id, email, role, created_at FROM admin_users;

/* ---------------------------------------------------------------------------
   2. MARKETING CMS
   site_content: one JSONB row per editable section (hero, faq, features, …).
   --------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS site_content (
    section    TEXT PRIMARY KEY,
    data       JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* blog_posts mirrors the previous Supabase schema (db/blog_posts.sql) exactly,
   minus the Supabase RLS policies (access is enforced in server code now). */
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

/* site_settings: single row (id = 1, CHECK-enforced) with site-wide SEO
   metadata; seeded empty so .eq("id", 1) reads/updates always resolve and
   the code merges its defaults over empty values. */
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

INSERT INTO site_settings (id, meta_title, meta_description, keywords,
                           og_title, og_description, site_url)
VALUES (1, '', '', '', '', '', '')
ON CONFLICT (id) DO NOTHING;

/* ---------------------------------------------------------------------------
   3. LEADS (marketing early-access form; email UNIQUE so a duplicate signup
   surfaces as 23505 and the form answers "already on the list")
   --------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS leads (
    id         BIGSERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL UNIQUE,
    company    TEXT,
    status     TEXT NOT NULL DEFAULT 'new',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leads_created_idx ON leads (created_at DESC);

/* Quick self-check you can RUN after applying (optional):
   SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('admin_users','admin_sessions','site_content',
                         'blog_posts','site_settings','leads')
    ORDER BY table_name;                                        -- 6 rows
   SELECT count(*) FROM site_settings;                          -- 1        */
