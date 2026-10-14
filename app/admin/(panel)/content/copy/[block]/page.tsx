import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "../../../../../../lib/supabase/server";
import { COPY_BLOCKS, copyOverrides, isCopyBlockKey, sanitizeCopy } from "../../../../../../lib/marketing/copy";
import CopyEditor from "./CopyEditor";

export default async function CopyBlockPage({ params }: { params: Promise<{ block: string }> }) {
  const { block } = await params;
  if (!isCopyBlockKey(block)) notFound();
  const spec = COPY_BLOCKS[block];

  const supabase = await createClient();
  const { data } = await supabase.from("site_content").select("data").eq("section", spec.section).maybeSingle();
  const value = sanitizeCopy(block, data?.data);
  const customised = Object.keys(copyOverrides(block, value)).length > 0;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-8">
        <Link href="/admin/content" className="text-xs text-ink-3 transition-colors hover:text-ink-2">
          ← Content
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">{spec.title}</h1>
        <p className="mt-1.5 text-sm text-ink-3">
          {spec.description} Leave a field empty to use the default text. Changes go live immediately.
        </p>
        <p className="mt-3 inline-flex rounded-md border border-line bg-soft px-2 py-1 text-[11px] text-ink-3">
          {customised ? "Showing your saved copy." : "Showing the built-in default copy (not customised yet)."}
        </p>
      </div>

      <CopyEditor blockKey={block} value={value} />
    </div>
  );
}
