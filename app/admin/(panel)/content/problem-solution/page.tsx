import Link from "next/link";
import { createClient } from "../../../../../lib/supabase/server";
import {
  PROBLEM_SOLUTION_DEFAULTS,
  type ProblemSolutionContent,
} from "../../../../../lib/content-defaults";
import ProblemSolutionForm from "./ProblemSolutionForm";

export default async function ProblemSolutionContentPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("site_content")
    .select("data")
    .eq("section", "problem_solution")
    .single();

  const content: ProblemSolutionContent = {
    ...PROBLEM_SOLUTION_DEFAULTS,
    ...((data?.data as Partial<ProblemSolutionContent>) ?? {}),
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
          Problem / Solution section
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Section heading, the comparison cards and the metrics strip. Changes
          go live immediately.
        </p>
      </div>

      <ProblemSolutionForm content={content} />
    </div>
  );
}