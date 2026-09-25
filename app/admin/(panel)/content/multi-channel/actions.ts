"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { createClient } from "../../../../../lib/supabase/server";
import type { MultiChannelContent } from "../../../../../lib/content-defaults";

export interface ContentActionState {
  success: boolean;
  message: string;
}

const FIELDS = [
  "badge",
  "heading_line1",
  "heading_line2",
  "description",
  "c1_name",
  "c1_short",
  "c1_desc",
  "c2_name",
  "c2_short",
  "c2_desc",
  "c3_name",
  "c3_short",
  "c3_desc",
  "c4_name",
  "c4_short",
  "c4_desc",
  "workflow_title",
  "workflow_subtitle",
  "actions",
  "bottom_note",
] as const;

export async function updateMultiChannelContent(
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
    return { success: false, message: "Heading and description are required." };
  }

  for (let i = 1; i <= 4; i++) {
    if (!values[`c${i}_name`] || !values[`c${i}_short`]) {
      return {
        success: false,
        message: `Channel ${i}: name and short code are required.`,
      };
    }
  }

  const { error } = await supabase.from("site_content").upsert({
    section: "multi_channel",
    data: values as unknown as MultiChannelContent,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    return { success: false, message: "Failed to save. Please try again." };
  }

  revalidateTag("site-content", "max");
  revalidatePath("/", "layout");

  return {
    success: true,
    message: "Saved — Multi-Channel section updated on the website.",
  };
}