"use server";

import { requireSiteAdmin, writeSiteContent } from "../../../../../lib/supabase/site-admin";
import { COPY_BLOCKS, copyOverrides, isCopyBlockKey, sanitizeCopy } from "../../../../../lib/marketing/copy";

export interface CopyActionState {
  success: boolean;
  message: string;
}

/**
 * Save (or reset) one copy block. The posted object is validated against
 * the defaults' shape and only the edited values are stored; reset stores
 * an empty row so the website shows the code defaults again.
 */
export async function saveCopyBlock(_prev: CopyActionState, formData: FormData): Promise<CopyActionState> {
  const { supabase, error } = await requireSiteAdmin();
  if (error) return { success: false, message: error };

  const key = formData.get("block");
  if (!isCopyBlockKey(key)) return { success: false, message: "Unknown copy block." };

  let data: Record<string, unknown> = {};
  let message = "Reset — the website shows the default copy again.";

  if (formData.get("intent") !== "reset") {
    let raw: unknown;
    try {
      raw = JSON.parse(String(formData.get("value") ?? "{}"));
    } catch {
      return { success: false, message: "Could not read the form. Please try again." };
    }
    data = copyOverrides(key, sanitizeCopy(key, raw));
    message = Object.keys(data).length
      ? "Saved — your copy is live on the website. Empty fields use the default text."
      : "Saved — nothing differs from the default copy.";
  }

  if (!(await writeSiteContent(supabase, COPY_BLOCKS[key].section, data))) {
    return { success: false, message: "Failed to save. Please try again." };
  }
  return { success: true, message };
}
