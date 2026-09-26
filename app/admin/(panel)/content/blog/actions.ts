"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { createClient } from "../../../../../lib/supabase/server";

export interface BlogActionState {
  success: boolean;
  message: string;
}

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

export async function saveBlogPost(
  _prevState: BlogActionState,
  formData: FormData
): Promise<BlogActionState> {
  const { supabase, user } = await requireUser();
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  const slug = String(formData.get("slug") ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const title = String(formData.get("title") ?? "").trim();
  const content = String(formData.get("content") ?? "").trim();

  if (!slug || !title || !content) {
    return {
      success: false,
      message: "Slug, title and content are required.",
    };
  }

  const published = String(formData.get("status") ?? "draft") === "published";
  const publishedAtRaw = String(formData.get("published_at") ?? "").trim();
  const publishedAt = published
    ? publishedAtRaw
      ? new Date(publishedAtRaw).toISOString()
      : new Date().toISOString()
    : null;

  const row = {
    slug,
    title,
    excerpt: String(formData.get("excerpt") ?? "").trim().slice(0, 400),
    category: String(formData.get("category") ?? "AI Automation").trim() || "AI Automation",
    author: String(formData.get("author") ?? "OmniFlow Team").trim() || "OmniFlow Team",
    reading_minutes: Math.max(
      1,
      Math.min(60, parseInt(String(formData.get("reading_minutes") ?? "5"), 10) || 5)
    ),
    content,
    status: published ? "published" : "draft",
    published_at: publishedAt,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("blog_posts")
    .upsert(row, { onConflict: "slug" });

  if (error) {
    const missing = error.message.includes("does not exist")
      ? " The blog_posts table is missing — run db/blog_posts.sql in the Supabase SQL editor once."
      : "";
    return { success: false, message: "Failed to save." + missing };
  }

  revalidateTag("blog-posts", "max");
  revalidatePath("/blog");
  revalidatePath("/blog/" + slug);

  return {
    success: true,
    message: published
      ? "Saved and published — /blog/" + slug + " is live."
      : "Saved as draft.",
  };
}

export async function deleteBlogPost(
  _prevState: BlogActionState,
  formData: FormData
): Promise<BlogActionState> {
  const { supabase, user } = await requireUser();
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }
  const slug = String(formData.get("delete_slug") ?? "").trim();
  if (!slug) {
    return { success: false, message: "Missing post." };
  }
  const { error } = await supabase
    .from("blog_posts")
    .delete()
    .eq("slug", slug);
  if (error) {
    return { success: false, message: "Failed to delete." };
  }
  revalidateTag("blog-posts", "max");
  revalidatePath("/blog");
  return { success: true, message: "Deleted " + slug + "." };
}
