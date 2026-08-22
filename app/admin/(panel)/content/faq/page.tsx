import Link from "next/link";
import { createClient } from "../../../../../lib/supabase/server";
import {
  FAQ_DEFAULTS,
  type FaqContent,
} from "../../../../../lib/content-defaults";
import FaqForm from "./FaqForm";

export default async function FaqContentPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("site_content")
    .select("data")
    .eq("section", "faq")
    .single();

  const content: FaqContent = {
    ...FAQ_DEFAULTS,
    ...((data?.data as Partial<FaqContent>) ?? {}),
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
          FAQ section
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Questions, answers and the contact email. Leave a question empty to
          hide it. Changes go live immediately.
        </p>
      </div>

      <FaqForm content={content} />
    </div>
  );
}