import Link from "next/link";
import { createClient } from "../../../../../lib/supabase/server";
import {
  HERO_DEFAULTS,
  type HeroContent,
} from "../../../../../lib/content-defaults";
import HeroForm from "./HeroForm";

export default async function HeroContentPage() {
  // Fresh, uncached read for the admin
  const supabase = await createClient();
  const { data } = await supabase
    .from("site_content")
    .select("data")
    .eq("section", "hero")
    .single();

  const content: HeroContent = {
    ...HERO_DEFAULTS,
    ...((data?.data as Partial<HeroContent>) ?? {}),
  };

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-8">
        <Link
          href="/admin/content"
          className="text-xs text-slate-500 transition-colors hover:text-slate-300"
        >
          ← Content
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white">
          Hero section
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          The first thing visitors see. Changes go live immediately.
        </p>
      </div>

      <HeroForm content={content} />
    </div>
  );
}