import Link from "next/link";
import { createClient } from "../../../../../lib/supabase/server";
import {
  MULTI_CHANNEL_DEFAULTS,
  type MultiChannelContent,
} from "../../../../../lib/content-defaults";
import MultiChannelForm from "./MultiChannelForm";

export default async function MultiChannelContentPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("site_content")
    .select("data")
    .eq("section", "multi_channel")
    .single();

  const content: MultiChannelContent = {
    ...MULTI_CHANNEL_DEFAULTS,
    ...((data?.data as Partial<MultiChannelContent>) ?? {}),
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
          Multi-Channel section
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Section heading, the 4 channel cards and the workflow strip. Changes
          go live immediately.
        </p>
      </div>

      <MultiChannelForm content={content} />
    </div>
  );
}