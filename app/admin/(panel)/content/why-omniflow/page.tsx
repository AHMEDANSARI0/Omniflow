import Link from "next/link";
import { createClient } from "../../../../../lib/supabase/server";
import {
  WHY_OMNIFLOW_DEFAULTS,
  type WhyOmniFlowContent,
} from "../../../../../lib/content-defaults";
import WhyOmniFlowForm from "./WhyOmniFlowForm";

export default async function WhyOmniFlowContentPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("site_content")
    .select("data")
    .eq("section", "why_omniflow")
    .single();

  const content: WhyOmniFlowContent = {
    ...WHY_OMNIFLOW_DEFAULTS,
    ...((data?.data as Partial<WhyOmniFlowContent>) ?? {}),
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
          Why OmniFlow section
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Section heading and the 4 benefit rows. The activity feed visual
          stays fixed. Changes go live immediately.
        </p>
      </div>

      <WhyOmniFlowForm content={content} />
    </div>
  );
}