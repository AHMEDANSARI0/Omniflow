import Link from "next/link";
import { createClient } from "../../../../../lib/supabase/server";
import BlogAdmin, { type AdminPost } from "./BlogAdmin";

export default async function BlogContentPage() {
  // Fresh, uncached read for the admin; missing table = empty list
  // (the website still shows the built-in seed articles).
  let posts: AdminPost[] = [];
  try {
    const supabase = await createClient();
    const { data } = await supabase
      .from("blog_posts")
      .select(
        "slug,title,excerpt,category,author,reading_minutes,status,published_at"
      )
      .order("updated_at", { ascending: false })
      .limit(100);
    if (data) {
      posts = data as unknown as AdminPost[];
    }
  } catch {
    posts = [];
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-8">
        <Link
          href="/admin/content"
          className="text-xs text-ink-3 transition-colors hover:text-ink-2"
        >
          ← Content
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">
          Blog
        </h1>
        <p className="mt-1.5 text-sm text-ink-3">
          Write, publish and manage the articles on /blog. Publishing is
          live the moment you save.
        </p>
      </div>
      <BlogAdmin posts={posts} />
    </div>
  );
}
