import "server-only";
import { unstable_cache } from "next/cache";
import { from } from "@/lib/db/neon";

/**
 * §276 — Site settings reader, now backed by NEON (was Supabase).
 * Single-row `site_settings` (id = 1). Non-empty DB values override the
 * defaults; empty/missing values fall back so the seeded (blank) row does not
 * wipe the defaults. Cached (tag `site-settings`) and fail-soft.
 */

export type SiteSettings = {
  meta_title: string;
  meta_description: string;
  keywords: string;
  og_title: string;
  og_description: string;
  site_url: string;
};

export const DEFAULT_SETTINGS: SiteSettings = {
  meta_title:
    "OmniFlow — AI Automation Agency | WhatsApp, Email & Social Media Bot",
  meta_description:
    "OmniFlow builds intelligent automation systems for Pakistani businesses — WhatsApp bots, email automation, social media management and AI agents that qualify leads, reply instantly and book appointments 24/7.",
  keywords:
    "AI automation agency Pakistan, WhatsApp bot Pakistan, AI chatbot for business, social media automation, email automation Pakistan, AI agent Karachi, lead generation automation, business automation Pakistan",
  og_title: "OmniFlow — AI Automation for Pakistani Businesses",
  og_description:
    "WhatsApp, email and social media automation powered by AI. We reply to leads in seconds, qualify them and book appointments — while you focus on closing.",
  site_url: "https://omniflow.vercel.app",
};

function pick(
  row: Record<string, unknown>,
  key: keyof SiteSettings,
  fallback: string
): string {
  const value = row[key];
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

export async function getSiteSettings(): Promise<SiteSettings> {
  const load = unstable_cache(
    async (): Promise<Record<string, unknown> | null> => {
      const { data, error } = await from("site_settings")
        .select("*")
        .eq("id", 1)
        .maybeSingle();
      if (error || !data) return null;
      return data as Record<string, unknown>;
    },
    ["site-settings"],
    { tags: ["site-settings"], revalidate: 300 }
  );

  try {
    const row = await load();
    if (!row) return DEFAULT_SETTINGS;
    return {
      meta_title: pick(row, "meta_title", DEFAULT_SETTINGS.meta_title),
      meta_description: pick(
        row,
        "meta_description",
        DEFAULT_SETTINGS.meta_description
      ),
      keywords: pick(row, "keywords", DEFAULT_SETTINGS.keywords),
      og_title: pick(row, "og_title", DEFAULT_SETTINGS.og_title),
      og_description: pick(
        row,
        "og_description",
        DEFAULT_SETTINGS.og_description
      ),
      site_url: pick(row, "site_url", DEFAULT_SETTINGS.site_url),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
