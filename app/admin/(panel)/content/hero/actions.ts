"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { createClient } from "../../../../../lib/supabase/server";
import type { HeroContent } from "../../../../../lib/content-defaults";

export interface ContentActionState {
  success: boolean;
  message: string;
}

export async function updateHeroContent(
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

  const values: HeroContent = {
    badge: String(formData.get("badge") ?? "").trim(),
    heading_line1: String(formData.get("heading_line1") ?? "").trim(),
    heading_line2: String(formData.get("heading_line2") ?? "").trim(),
    description: String(formData.get("description") ?? "").trim(),
    primary_button: String(formData.get("primary_button") ?? "").trim(),
    secondary_button: String(formData.get("secondary_button") ?? "").trim(),
    channels_label: String(formData.get("channels_label") ?? "").trim(),
    integrations: String(formData.get("integrations") ?? "").trim(),
  };

  if (!values.heading_line1 || !values.description) {
    return {
      success: false,
      message: "Heading and description are required.",
    };
  }

  const { error } = await supabase.from("site_content").upsert({
    section: "hero",
    data: values,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    return { success: false, message: "Failed to save. Please try again." };
  }

  revalidateTag("site-content", "max");
  revalidatePath("/", "layout");

  return { success: true, message: "Saved — Hero section updated on the website." };
}