import { revalidatePath, revalidateTag } from "next/cache";
import { createClient } from "./server";

/**
 * Server-action helpers for the admin website-content editors. Server
 * actions are callable directly, so each one repeats the panel's role
 * gate before writing.
 */
export async function requireSiteAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { supabase, error: "Not authenticated." };
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return { supabase, error: "Only admins can edit website content." };
  return { supabase, error: null };
}

/** Upsert one `site_content` row and refresh every page that reads it. */
export async function writeSiteContent(
  supabase: Awaited<ReturnType<typeof createClient>>,
  section: string,
  data: object
) {
  const { error } = await supabase.from("site_content").upsert({
    section,
    data,
    updated_at: new Date().toISOString(),
  });
  if (error) return false;
  revalidateTag("site-content", "max");
  revalidatePath("/", "layout");
  return true;
}
