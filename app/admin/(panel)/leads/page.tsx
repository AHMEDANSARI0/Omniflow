import { createClient } from "../../../../lib/supabase/server";
import type { Lead } from "./types";
import LeadsTable from "./LeadsTable";

export default async function LeadsPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("leads")
    .select("*")
    .order("created_at", { ascending: false });

  const leads = (data as Lead[] | null) ?? [];
  const newCount = leads.filter((l) => l.status === "new").length;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Leads
          </h1>
          <p className="mt-1.5 text-sm text-slate-400">
            Early-access requests from the website.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-xl border border-white/[0.06] bg-white/[0.015] px-4 py-2 text-xs text-slate-400">
            Total: <span className="font-semibold text-white">{leads.length}</span>
          </span>
          <span className="rounded-xl border border-cyan-400/15 bg-cyan-400/[0.05] px-4 py-2 text-xs text-cyan-300">
            New: <span className="font-semibold">{newCount}</span>
          </span>
        </div>
      </div>

      {leads.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] px-6 py-16 text-center">
          <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.02] text-slate-500">
            ◇
          </div>
          <p className="text-sm font-medium text-slate-300">No leads yet</p>
          <p className="mt-1.5 text-xs text-slate-500">
            When someone requests early access on the website, they&apos;ll
            appear here.
          </p>
        </div>
      ) : (
        <LeadsTable leads={leads} />
      )}
    </div>
  );
}