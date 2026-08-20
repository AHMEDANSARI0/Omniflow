"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { createClient } from "../../../../../lib/supabase/server";
import type { TrustContent } from "../../../../../lib/content-defaults";

export interface ContentActionState {
  success: boolean;
  message: string;
}

const FIELDS = [
  "badge",
  "heading_line1",
  "heading_line2",
  "description",
  "p1_title",
  "p1_desc",
  "p2_title",
  "p2_desc",
  "p3_title",
  "p3_desc",
  "p4_title",
  "p4_desc",
  "principles",
] as const;

export async function updateTrustContent(
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
    if (!values[`p${i}_title`] || !values[`p${i}_desc`]) {
      return {
        success: false,
        message: `Pillar 0${i}: title and description are required.`,
      };
    }
  }

  const { error } = await supabase.from("site_content").upsert({
    section: "trust",
    data: values as unknown as TrustContent,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    return { success: false, message: "Failed to save. Please try again." };
  }

  revalidateTag("site-content", "max");
  revalidatePath("/", "layout");

  return {
    success: true,
    message: "Saved — Trust section updated on the website.",
  };
}