"use server";

import { redirect } from "next/navigation";
import { overrideSpecs, resetOverride, tidyRow } from "../../../../../lib/marketing/overrides";
import { requireSiteAdmin, writeSiteContent } from "../../../../../lib/supabase/site-admin";

/**
 * §256 CMS overrides: hand one field, or a whole row, back to the code
 * defaults, and tidy rows (drop stored values that equal the defaults -
 * the page renders the same, later code updates reach it again).
 */
type Admin = Awaited<ReturnType<typeof requireSiteAdmin>>["supabase"];

const PAGE = "/admin/content/overrides";

async function storedRow(supabase: Admin, section: string): Promise<unknown> {
  const { data } = await supabase.from("site_content").select("data").eq("section", section).maybeSingle();
  return data?.data ?? {};
}

function done(result: string): never {
  redirect(PAGE + "?done=" + result);
}

export async function resetOverrideField(formData: FormData) {
  const { supabase, error } = await requireSiteAdmin();
  if (error) done("denied");
  const section = String(formData.get("section") ?? "");
  const path = String(formData.get("path") ?? "");
  if (!overrideSpecs()[section]) done("unknown");
  const next = resetOverride(section, await storedRow(supabase, section), path);
  if (!next) done("unknown");
  done((await writeSiteContent(supabase, section, next)) ? "field" : "failed");
}

export async function resetOverrideRow(formData: FormData) {
  const { supabase, error } = await requireSiteAdmin();
  if (error) done("denied");
  const section = String(formData.get("section") ?? "");
  if (!overrideSpecs()[section]) done("unknown");
  done((await writeSiteContent(supabase, section, {})) ? "row" : "failed");
}

export async function tidyOverrides() {
  const { supabase, error } = await requireSiteAdmin();
  if (error) done("denied");
  const specs = overrideSpecs();
  const { data, error: readError } = await supabase.from("site_content").select("section, data");
  if (readError) done("failed");
  let ok = true;
  for (const row of data ?? []) {
    const section = String(row.section ?? "");
    if (!specs[section]) continue;
    const minimal = tidyRow(section, row.data);
    if (JSON.stringify(minimal) !== JSON.stringify(row.data ?? {})) {
      ok = (await writeSiteContent(supabase, section, minimal)) && ok;
    }
  }
  done(ok ? "tidy" : "failed");
}
