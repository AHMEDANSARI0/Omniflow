"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { createClient } from "../../../../../lib/supabase/server";
import type { FaqContent } from "../../../../../lib/content-defaults";

export interface ContentActionState {
  success: boolean;
  message: string;
}

const FIELDS = [
  "badge",
  "heading_line1",
  "heading_line2",
  "description",
  "q1",
  "a1",
  "q2",
  "a2",
  "q3",
  "a3",
  "q4",
  "a4",
  "q5",
  "a5",
  "q6",
  "a6",
  "contact_text",
  "contact_email",
] as const;

export async function updateFaqContent(
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

  if (!values.heading_line1) {
    return { success: false, message: "Heading is required." };
  }

  if (!values.q1 || !values.a1) {
    return {
      success: false,
      message: "At least the first question and answer are required.",
    };
  }

  const { error } = await supabase.from("site_content").upsert({
    section: "faq",
    data: values as unknown as FaqContent,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    return { success: false, message: "Failed to save. Please try again." };
  }

  revalidateTag("site-content", "max");
  revalidatePath("/", "layout");

  return { success: true, message: "Saved — FAQ updated on the website." };
}