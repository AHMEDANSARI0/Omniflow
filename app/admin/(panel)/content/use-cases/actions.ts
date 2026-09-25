"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { createClient } from "../../../../../lib/supabase/server";
import type { UseCasesContent } from "../../../../../lib/content-defaults";

export interface ContentActionState {
  success: boolean;
  message: string;
}

const SECTION_FIELDS = [
  "badge",
  "heading_line1",
  "heading_line2",
  "description",
] as const;

const CASE_FIELDS = ["label", "headline", "desc", "automations", "status"] as const;

export async function updateUseCasesContent(
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
  for (const field of SECTION_FIELDS) {
    values[field] = String(formData.get(field) ?? "").trim();
  }
  for (let i = 1; i <= 5; i++) {
    for (const field of CASE_FIELDS) {
      const key = `u${i}_${field}`;
      values[key] = String(formData.get(key) ?? "").trim();
    }
  }

  if (!values.heading_line1 || !values.description) {
    return { success: false, message: "Heading and description are required." };
  }

  for (let i = 1; i <= 5; i++) {
    if (!values[`u${i}_label`] || !values[`u${i}_headline`] || !values[`u${i}_desc`]) {
      return {
        success: false,
        message: `Use case ${i}: label, headline and description are required.`,
      };
    }
  }

  const { error } = await supabase.from("site_content").upsert({
    section: "use_cases",
    data: values as unknown as UseCasesContent,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    return { success: false, message: "Failed to save. Please try again." };
  }

  revalidateTag("site-content", "max");
  revalidatePath("/", "layout");

  return {
    success: true,
    message: "Saved — Use Cases section updated on the website.",
  };
}