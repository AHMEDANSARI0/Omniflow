"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { createClient } from "../../../../../lib/supabase/server";
import type { WhyOmniFlowContent } from "../../../../../lib/content-defaults";

export interface ContentActionState {
  success: boolean;
  message: string;
}

const FIELDS = [
  "badge",
  "heading_line1",
  "heading_line2",
  "description",
  "b1_title",
  "b1_desc",
  "b2_title",
  "b2_desc",
  "b3_title",
  "b3_desc",
  "b4_title",
  "b4_desc",
] as const;

export async function updateWhyOmniFlowContent(
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
    if (!values[`b${i}_title`] || !values[`b${i}_desc`]) {
      return {
        success: false,
        message: `Benefit 0${i}: title and description are required.`,
      };
    }
  }

  const { error } = await supabase.from("site_content").upsert({
    section: "why_omniflow",
    data: values as unknown as WhyOmniFlowContent,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    return { success: false, message: "Failed to save. Please try again." };
  }

  revalidateTag("site-content", "max");
  revalidatePath("/", "layout");

  return {
    success: true,
    message: "Saved — Why OmniFlow section updated on the website.",
  };
}