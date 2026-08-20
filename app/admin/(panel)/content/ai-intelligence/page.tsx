import Link from "next/link";
import { createClient } from "../../../../../lib/supabase/server";
import {
  AI_INTELLIGENCE_DEFAULTS,
  type AiIntelligenceContent,
} from "../../../../../lib/content-defaults";
import AiIntelligenceForm from "./AiIntelligenceForm";

export default async function AiIntelligenceContentPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("site_content")
    .select("data")
    .eq("section", "ai_intelligence")
    .single();

  const content: AiIntelligenceContent = {
    ...AI_INTELLIGENCE_DEFAULTS,
    ...((data?.data as Partial<AiIntelligenceContent>) ?? {}),
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
          AI Intelligence section
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Section heading and the 3 intelligence pillars. The engine demo
          visual stays fixed. Changes go live immediately.
        </p>
      </div>

      <AiIntelligenceForm content={content} />
    </div>
  );
}
