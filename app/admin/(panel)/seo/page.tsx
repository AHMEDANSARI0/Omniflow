import { createClient } from "../../../../lib/supabase/server";
import { DEFAULT_SETTINGS, type SiteSettings } from "../../../../lib/settings";
import SeoForm from "./SeoForm";

export default async function SeoPage() {
  // Fresh, uncached read for the admin (authenticated server client)
  const supabase = await createClient();
  const { data } = await supabase
    .from("site_settings")
    .select("*")
    .eq("id", 1)
    .single();

  const settings = (data as SiteSettings | null) ?? DEFAULT_SETTINGS;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          SEO settings
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Control how the website appears in search engines and social shares.
          Changes go live immediately.
        </p>
      </div>

      <SeoForm settings={settings} />
    </div>
  );
}