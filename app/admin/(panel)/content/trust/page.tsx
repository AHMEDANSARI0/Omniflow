import Link from "next/link";
import { createClient } from "../../../../../lib/supabase/server";
import {
  TRUST_DEFAULTS,
  type TrustContent,
} from "../../../../../lib/content-defaults";
import TrustForm from "./TrustForm";

export default async function TrustContentPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("site_content")
    .select("data")
    .eq("section", "trust")
    .single();

  const content: TrustContent = {
    ...TRUST_DEFAULTS,
    ...((data?.data as Partial<TrustContent>) ?? {}),
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
          Trust section
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Section heading, the 4 trust pillars and the principles strip.
          Changes go live immediately.
        </p>
      </div>

      <TrustForm content={content} />
    </div>
  );
}