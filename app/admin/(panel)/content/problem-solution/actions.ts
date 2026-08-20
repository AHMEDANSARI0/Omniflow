"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { createClient } from "../../../../../lib/supabase/server";
import type { ProblemSolutionContent } from "../../../../../lib/content-defaults";

export interface ContentActionState {
  success: boolean;
  message: string;
}

const FIELDS = [
  "badge",
  "heading_line1",
  "heading_line2",
  "description",
  "problem_title",
  "problems",
  "solution_title",
  "solutions",
  "m1_value",
  "m1_label",
  "m2_value",
  "m2_label",
  "m3_value",
  "m3_label",
  "m4_value",
  "m4_label",
] as const;

export async function updateProblemSolutionContent(
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

  if (!values.problems || !values.solutions) {
    return {
      success: false,
      message: "Problem and solution lists are required.",
    };
  }

  const { error } = await supabase.from("site_content").upsert({
    section: "problem_solution",
    data: values as unknown as ProblemSolutionContent,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    return { success: false, message: "Failed to save. Please try again." };
  }

  revalidateTag("site-content", "max");
  revalidatePath("/", "layout");

  return {
    success: true,
    message: "Saved — Problem/Solution section updated on the website.",
  };
}