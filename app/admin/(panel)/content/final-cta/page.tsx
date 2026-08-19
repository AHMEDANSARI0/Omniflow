import Link from "next/link";
import { createClient } from "../../../../../lib/supabase/server";
import {
  FINAL_CTA_DEFAULTS,
  type FinalCtaContent,
} from "../../../../../lib/content-defaults";
import FinalCtaForm from "./FinalCtaForm";

export default async function FinalCtaContentPage() {
  // Fresh, uncached read for the admin
  const supabase = await createClient();
  const { data } = await supabase
    .from("site_content")
    .select("data")
    .eq("section", "final_cta")
    .single();

  const content: FinalCtaContent = {
    ...FINAL_CTA_DEFAULTS,
    ...((data?.data as Partial<FinalCtaContent>) ?? {}),
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
          Final CTA section
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          The early-access conversion panel. Changes go live immediately.
        </p>
      </div>

      <FinalCtaForm content={content} />
    </div>
  );
}