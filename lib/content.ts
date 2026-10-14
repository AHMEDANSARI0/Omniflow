import "server-only";
import { unstable_cache } from "next/cache";
import { from } from "@/lib/db/neon";

/**
 * §276 — Section content reader, now backed by NEON (was Supabase).
 * Reads editable marketing sections from `site_content` (JSONB `data`),
 * merged over the in-file fallback. Cached (tag `site-content`) and
 * fail-soft: any error returns the fallback so the public site never breaks.
 */

export function defaultSectionContent<T extends object>(fallback: T): T {
  return fallback;
}

export async function getSectionContent<T extends object>(
  section: string,
  fallback: T
): Promise<T> {
  try {
    // `section` is part of the cache key so each section caches independently.
    const load = unstable_cache(
      async (sec: string) => {
        const { data, error } = await from("site_content")
          .select("data")
          .eq("section", sec)
          .maybeSingle();
        if (error || !data) return null;
        return (data.data as Record<string, unknown> | null) ?? null;
      },
      ["site-content", section],
      { tags: ["site-content"], revalidate: 300 }
    );
    const dbData = await load(section);
    return dbData ? { ...fallback, ...(dbData as Partial<T>) } : fallback;
  } catch {
    return fallback;
  }
}
