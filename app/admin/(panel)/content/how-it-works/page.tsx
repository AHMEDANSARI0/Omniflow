import Link from "next/link";
import { createClient } from "../../../../../lib/supabase/server";
import {
  HOW_IT_WORKS_DEFAULTS,
  type HowItWorksContent,
} from "../../../../../lib/content-defaults";
import HowItWorksForm from "./HowItWorksForm";

export default async function HowItWorksContentPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("site_content")
    .select("data")
    .eq("section", "how_it_works")
    .single();

  const content: HowItWorksContent = {
    ...HOW_IT_WORKS_DEFAULTS,
    ...((data?.data as Partial<HowItWorksContent>) ?? {}),
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
          How It Works section
        </h1>
        <p className="mt-1.5 text-sm text-ink-3">
          Section heading and the 4 workflow steps. The builder preview stays
          fixed. Changes go live immediately.
        </p>
      </div>

      <HowItWorksForm content={content} />
    </div>
  );
}