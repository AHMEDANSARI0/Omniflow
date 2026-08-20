import Link from "next/link";
import { createClient } from "../../../../../lib/supabase/server";
import {
  CUSTOMER_MEMORY_DEFAULTS,
  type CustomerMemoryContent,
} from "../../../../../lib/content-defaults";
import CustomerMemoryForm from "./CustomerMemoryForm";

export default async function CustomerMemoryContentPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("site_content")
    .select("data")
    .eq("section", "customer_memory")
    .single();

  const content: CustomerMemoryContent = {
    ...CUSTOMER_MEMORY_DEFAULTS,
    ...((data?.data as Partial<CustomerMemoryContent>) ?? {}),
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
          Customer Memory section
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Section heading, context points and bottom note. The profile demo
          visual stays fixed. Changes go live immediately.
        </p>
      </div>

      <CustomerMemoryForm content={content} />
    </div>
  );
}
