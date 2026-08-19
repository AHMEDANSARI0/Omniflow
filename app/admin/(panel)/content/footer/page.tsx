import Link from "next/link";
import { createClient } from "../../../../../lib/supabase/server";
import {
  FOOTER_DEFAULTS,
  type FooterContent,
} from "../../../../../lib/content-defaults";
import FooterForm from "./FooterForm";

export default async function FooterContentPage() {
  // Fresh, uncached read for the admin
  const supabase = await createClient();
  const { data } = await supabase
    .from("site_content")
    .select("data")
    .eq("section", "footer")
    .single();

  const content: FooterContent = {
    ...FOOTER_DEFAULTS,
    ...((data?.data as Partial<FooterContent>) ?? {}),
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
          Footer
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Brand description, status pill and social links. Changes go live
          immediately.
        </p>
      </div>

      <FooterForm content={content} />
    </div>
  );
}