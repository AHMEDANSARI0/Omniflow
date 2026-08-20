"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { createClient } from "../../../../../lib/supabase/server";
import type { AiIntelligenceContent } from "../../../../../lib/content-defaults";

export interface ContentActionState {
  success: boolean;
  message: string;
}

const FIELDS = [
  "badge",
  "heading_line1",
  "heading_line2",
  "description",
  "i1_title",
  "i1_desc",
  "i1_tags",
  "i2_title",
  "i2_desc",
  "i2_tags",
  "i3_title",
  "i3_desc",
  "i3_tags",
] as const;

export async function updateAiIntelligenceContent(
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

  for (let i = 1; i <= 3; i++) {
    if (!values[`i${i}_title`] || !values[`i${i}_desc`]) {
      return {
        success: false,
        message: `Pillar 0${i}: title and description are required.`,
      };
    }
  }

  const { error } = await supabase.from("site_content").upsert({
    section: "ai_intelligence",
    data: values as unknown as AiIntelligenceContent,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    return { success: false, message: "Failed to save. Please try again." };
  }

  revalidateTag("site-content", "max");
  revalidatePath("/", "layout");

  return {
    success: true,
    message: "Saved — AI Intelligence section updated on the website.",
  };
}
