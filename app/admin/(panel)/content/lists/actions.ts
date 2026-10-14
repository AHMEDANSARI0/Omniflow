"use server";

import { requireSiteAdmin, writeSiteContent } from "../../../../../lib/supabase/site-admin";
import { isMarketingListKey, MARKETING_LISTS, sanitizeList } from "../../../../../lib/marketing/lists";
import { sameContent } from "../../../../../lib/marketing/overrides";

export interface ListActionState {
  success: boolean;
  message: string;
}

/**
 * Save (or reset) one marketing list as a `site_content` row. The list
 * is re-validated here with the same schema the website uses, so the
 * stored row is always renderable. Reset stores an empty row, which
 * makes the website fall back to the code defaults again.
 */
export async function saveMarketingList(
  _prev: ListActionState,
  formData: FormData
): Promise<ListActionState> {
  const { supabase, error } = await requireSiteAdmin();
  if (error) return { success: false, message: error };

  const key = formData.get("list");
  if (!isMarketingListKey(key)) return { success: false, message: "Unknown list." };
  const spec = MARKETING_LISTS[key];

  let data: { items?: unknown[] } = {};
  let message = "Reset — the website shows the default list again.";

  if (formData.get("intent") !== "reset") {
    let raw: unknown;
    try {
      raw = JSON.parse(String(formData.get("items") ?? "[]"));
    } catch {
      return { success: false, message: "Could not read the list. Please try again." };
    }
    const sent = Array.isArray(raw) ? raw.length : 0;
    const items = sanitizeList(key, raw);
    if (!items.length) {
      return {
        success: false,
        message:
          "fixed" in spec && spec.fixed
            ? `All ${spec.defaults.length} ${spec.itemLabel}s need every required field.`
            : `Add at least one complete ${spec.itemLabel} (all required fields filled).`,
      };
    }
    const skipped = sent - items.length;
    // §256: a list equal to the defaults is stored empty, so later code
    // updates to the default list still reach the site
    data = sameContent(items, spec.defaults) ? {} : { items };
    message =
      `Saved — ${items.length} ${spec.itemLabel}${items.length === 1 ? "" : "s"} live on the website.` +
      (skipped > 0 ? ` ${skipped} incomplete or extra item${skipped === 1 ? " was" : "s were"} skipped.` : "");
  }

  if (!(await writeSiteContent(supabase, spec.section, data))) {
    return { success: false, message: "Failed to save. Please try again." };
  }
  return { success: true, message };
}
