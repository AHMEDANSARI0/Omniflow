"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { createClient } from "../../../../../lib/supabase/server";
import type { HowItWorksContent } from "../../../../../lib/content-defaults";

export interface ContentActionState {
  success: boolean;
  message: string;
}

const FIELDS = [
  "badge",
  "heading_line1",
  "heading_line2",
  "description",
  "s1_type",
  "s1_title",
  "s1_desc",
  "s2_type",
  "s2_title",
  "s2_desc",
  "s3_type",
  "s3_title",
  "s3_desc",
  "s4_type",
  "s4_title",
  "s4_desc",
  "bottom_note",
] as const;

export async function updateHowItWorksContent(
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
    if (!values[`s${i}_title`] || !values[`s${i}_desc`]) {
      return {
        success: false,
        message: `Step 0${i}: title and description are required.`,
      };
    }
  }

  const { error } = await supabase.from("site_content").upsert({
    section: "how_it_works",
    data: values as unknown as HowItWorksContent,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    return { success: false, message: "Failed to save. Please try again." };
  }

  revalidateTag("site-content", "max");
  revalidatePath("/", "layout");

  return {
    success: true,
    message: "Saved — How It Works section updated on the website.",
  };
}