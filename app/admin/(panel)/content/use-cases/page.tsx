import Link from "next/link";
import { createClient } from "../../../../../lib/supabase/server";
import {
  USE_CASES_DEFAULTS,
  type UseCasesContent,
} from "../../../../../lib/content-defaults";
import UseCasesForm from "./UseCasesForm";

export default async function UseCasesContentPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("site_content")
    .select("data")
    .eq("section", "use_cases")
    .single();

  const content: UseCasesContent = {
    ...USE_CASES_DEFAULTS,
    ...((data?.data as Partial<UseCasesContent>) ?? {}),
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
          Use Cases section
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Section heading and the 5 business use cases. The demo chat previews
          stay fixed. Changes go live immediately.
        </p>
      </div>

      <UseCasesForm content={content} />
    </div>
  );
}