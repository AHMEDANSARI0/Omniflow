"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { createClient } from "../../../../../lib/supabase/server";
import type { FooterContent } from "../../../../../lib/content-defaults";

export interface ContentActionState {
  success: boolean;
  message: string;
}

function isValidUrlOrPlaceholder(value: string): boolean {
  if (value === "" || value === "#") return true;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export async function updateFooterContent(
  _prevState: ContentActionState,
  formData: FormData
): Promise<ContentActionState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  const values: FooterContent = {
    description: String(formData.get("description") ?? "").trim(),
    status_label: String(formData.get("status_label") ?? "").trim(),
    linkedin_url: String(formData.get("linkedin_url") ?? "").trim(),
    x_url: String(formData.get("x_url") ?? "").trim(),
    instagram_url: String(formData.get("instagram_url") ?? "").trim(),
  };

  if (!values.description) {
    return { success: false, message: "Description is required." };
  }

  for (const [label, url] of [
    ["LinkedIn", values.linkedin_url],
    ["X", values.x_url],
    ["Instagram", values.instagram_url],
  ] as const) {
    if (!isValidUrlOrPlaceholder(url)) {
      return {
        success: false,
        message: `${label} URL must be a valid link (https://…), "#", or empty to hide it.`,
      };
    }
  }

  const { error } = await supabase.from("site_content").upsert({
    section: "footer",
    data: values,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    return { success: false, message: "Failed to save. Please try again." };
  }

  revalidateTag("site-content", "max");
  revalidatePath("/", "layout");

  return { success: true, message: "Saved — Footer updated on the website." };
}