import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Generic, cached content reader for the marketing site.
 * Each website section stores its editable text as a JSON row in
 * `site_content` (keyed by section name).
 *
 * - Values from the DB are merged over code-level fallbacks, so the
 *   website never breaks if the DB is unreachable or a field is missing.
 * - Reads are cached and tagged; admin save actions revalidate the tag
 *   so edits go live instantly.
 */
export async function getSectionContent<T extends Record<string, unknown>>(
  section: string,
  fallback: T
): Promise<T> {
  try {
    const supabase = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: { persistSession: false },
        global: {
          fetch: (url, init) =>
            fetch(url, {
              ...init,
              next: { revalidate: 300, tags: ["site-content"] },
            }),
        },
      }
    );

    const { data, error } = await supabase
      .from("site_content")
      .select("data")
      .eq("section", section)
      .single();

    if (error || !data?.data) {
      return fallback;
    }

    return { ...fallback, ...(data.data as Partial<T>) };
  } catch {
    return fallback;
  }
}