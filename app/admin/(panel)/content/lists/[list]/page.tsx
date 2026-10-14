import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "../../../../../../lib/supabase/server";
import { isMarketingListKey, MARKETING_LISTS, sanitizeList } from "../../../../../../lib/marketing/lists";
import ListEditor from "./ListEditor";

export default async function MarketingListPage({ params }: { params: Promise<{ list: string }> }) {
  const { list } = await params;
  if (!isMarketingListKey(list)) notFound();
  const spec = MARKETING_LISTS[list];

  const supabase = await createClient();
  const { data } = await supabase.from("site_content").select("data").eq("section", spec.section).maybeSingle();
  const saved = sanitizeList(list, (data?.data as { items?: unknown } | null)?.items);
  const usingDefaults = saved.length === 0;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-8">
        <Link href="/admin/content" className="text-xs text-ink-3 transition-colors hover:text-ink-2">
          ← Content
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">{spec.title}</h1>
        <p className="mt-1.5 text-sm text-ink-3">
          {spec.description} Changes go live immediately.
        </p>
        <p className="mt-3 inline-flex rounded-md border border-line bg-soft px-2 py-1 text-[11px] text-ink-3">
          {usingDefaults ? "Showing the built-in default list (not saved yet)." : "Showing your saved list."}
        </p>
      </div>

      <ListEditor listKey={list} items={usingDefaults ? spec.defaults : saved} />
    </div>
  );
}
