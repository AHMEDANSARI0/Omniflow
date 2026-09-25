import Link from "next/link";
import { createClient } from "../../../../../lib/supabase/server";
import {
  FEATURES_DEFAULTS,
  type FeaturesContent,
} from "../../../../../lib/content-defaults";
import FeaturesForm from "./FeaturesForm";

export default async function FeaturesContentPage() {
  // Fresh, uncached read for the admin
  const supabase = await createClient();
  const { data } = await supabase
    .from("site_content")
    .select("data")
    .eq("section", "features")
    .single();

  const content: FeaturesContent = {
    ...FEATURES_DEFAULTS,
    ...((data?.data as Partial<FeaturesContent>) ?? {}),
  };

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-8">
        <Link
          href="/admin/content"
          className="text-xs text-ink-3 transition-colors hover:text-ink-2"
        >
          ← Content
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">
          Features section
        </h1>
        <p className="mt-1.5 text-sm text-ink-3">
          Section heading, the 6 capability cards and the capability strip.
          Changes go live immediately.
        </p>
      </div>

      <FeaturesForm content={content} />
    </div>
  );
}