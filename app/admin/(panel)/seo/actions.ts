"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { createClient } from "../../../../lib/supabase/server";

export interface SeoActionState {
  success: boolean;
  message: string;
}

export async function updateSeoSettings(
  _prevState: SeoActionState,
  formData: FormData
): Promise<SeoActionState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  const values = {
    meta_title: String(formData.get("meta_title") ?? "").trim(),
    meta_description: String(formData.get("meta_description") ?? "").trim(),
    keywords: String(formData.get("keywords") ?? "").trim(),
    og_title: String(formData.get("og_title") ?? "").trim(),
    og_description: String(formData.get("og_description") ?? "").trim(),
    site_url: String(formData.get("site_url") ?? "").trim(),
  };

  if (!values.meta_title || !values.meta_description) {
    return {
      success: false,
      message: "Meta title and meta description are required.",
    };
  }

  try {
    new URL(values.site_url);
  } catch {
    return {
      success: false,
      message: "Site URL must be a valid URL (e.g. https://omniflow.com).",
    };
  }

  const { error } = await supabase
    .from("site_settings")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("id", 1);

  if (error) {
    return { success: false, message: "Failed to save. Please try again." };
  }

  // Refresh the cached settings + regenerate site metadata
  revalidateTag("site-settings", "max");
  revalidatePath("/", "layout");

  return { success: true, message: "Saved — website metadata updated." };
}