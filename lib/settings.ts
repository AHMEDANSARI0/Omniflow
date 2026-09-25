import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Site-wide settings stored in Supabase (single row, id = 1).
 * Used by the marketing site's generateMetadata and the admin SEO module.
 */
export interface SiteSettings {
  id: number;
  meta_title: string;
  meta_description: string;
  keywords: string;
  og_title: string;
  og_description: string;
  site_url: string;
  updated_at: string;
}

/** Safe fallbacks — the website must never break if the DB is unreachable. */
export const DEFAULT_SETTINGS: SiteSettings = {
  id: 1,
  meta_title: "OmniFlow — AI Customer Conversation Automation",
  meta_description:
    "OmniFlow is an AI automation platform for customer conversations. Connect your channels, qualify leads, automate follow-ups and route conversations — all from one intelligent layer.",
  keywords:
    "AI automation, customer conversation automation, AI chatbot platform, lead qualification, multi-channel automation, workflow automation, conversational AI",
  og_title: "OmniFlow — AI Customer Conversation Automation",
  og_description:
    "Connect your channels, qualify leads, automate follow-ups and route conversations — all from one intelligent AI layer.",
  site_url: "https://omniflow.example.com",
  updated_at: new Date(0).toISOString(),
};

/**
 * Public, cookie-free read used by the marketing site.
 * Tagged + time-based caching so the site stays fast; the admin save
 * action revalidates the tag for instant updates.
 */
export async function getSiteSettings(): Promise<SiteSettings> {
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
              next: { revalidate: 300, tags: ["site-settings"] },
            }),
        },
      }
    );

    const { data, error } = await supabase
      .from("site_settings")
      .select("*")
      .eq("id", 1)
      .single();

    if (error || !data) {
      return DEFAULT_SETTINGS;
    }

    return data as SiteSettings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}