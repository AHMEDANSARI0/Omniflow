"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { createClient } from "../../../../../lib/supabase/server";
import { FEATURES_DEFAULTS } from "../../../../../lib/content-defaults";
import { sectionOverrides } from "../../../../../lib/marketing/overrides";

export interface ContentActionState {
  success: boolean;
  message: string;
}

const FIELDS = [
  "badge",
  "heading_line1",
  "heading_line2",
  "description",
  "f1_title",
  "f1_desc",
  "f2_title",
  "f2_desc",
  "f3_title",
  "f3_desc",
  "f4_title",
  "f4_desc",
  "f5_title",
  "f5_desc",
  "f6_title",
  "f6_desc",
  "capabilities",
] as const;

export async function updateFeaturesContent(
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

  const values = {} as Record<string, string>;
  for (const field of FIELDS) {
    values[field] = String(formData.get(field) ?? "").trim();
  }

  if (!values.heading_line1 || !values.description) {
    return {
      success: false,
      message: "Heading and description are required.",
    };
  }

  for (let i = 1; i <= 6; i++) {
    if (!values[`f${i}_title`] || !values[`f${i}_desc`]) {
      return {
        success: false,
        message: `Feature 0${i}: title and description are required.`,
      };
    }
  }

  const { error } = await supabase.from("site_content").upsert({
    section: "features",
    // §256: only what differs from the defaults - later copy updates still reach the site
    data: sectionOverrides(values as Record<string, unknown>, FEATURES_DEFAULTS),
    updated_at: new Date().toISOString(),
  });

  if (error) {
    return { success: false, message: "Failed to save. Please try again." };
  }

  revalidateTag("site-content", "max");
  revalidatePath("/", "layout");

  return {
    success: true,
    message: "Saved — Features section updated on the website.",
  };
}