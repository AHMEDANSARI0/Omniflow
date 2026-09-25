-- OmniFlow blog posts (the marketing blog's CMS store).
-- Apply once in the Supabase SQL editor. Until this table exists the
-- website serves the built-in seed articles from lib/blog.ts, so the
-- blog works either way.

CREATE TABLE IF NOT EXISTS blog_posts (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'AI Automation',
  author TEXT NOT NULL DEFAULT 'OmniFlow Team',
  reading_minutes INT NOT NULL DEFAULT 4,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS blog_posts_published_idx
  ON blog_posts (status, published_at DESC);

ALTER TABLE blog_posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "blog public read" ON blog_posts;
CREATE POLICY "blog public read" ON blog_posts
  FOR SELECT USING (status = 'published');

DROP POLICY IF EXISTS "blog admin write" ON blog_posts;
CREATE POLICY "blog admin write" ON blog_posts
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
