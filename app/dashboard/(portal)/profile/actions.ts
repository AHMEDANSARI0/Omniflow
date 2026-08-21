"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "../../../../lib/supabase/server";

export interface ProfileActionState {
  success: boolean;
  message: string;
}

const FIELDS = [
  "business_name",
  "industry",
  "phone",
  "website",
  "address",
  "timezone",
  "business_hours",
  "default_language",
] as const;

export async function updateBusinessProfile(
  _prevState: ProfileActionState,
  formData: FormData
): Promise<ProfileActionState> {
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

  if (!values.business_name) {
    return { success: false, message: "Business name is required." };
  }

  if (values.website) {
    try {
      new URL(values.website);
    } catch {
      return {
        success: false,
        message: "Website must be a valid URL (https://…) or empty.",
      };
    }
  }

  const { error } = await supabase.from("business_profiles").upsert({
    id: user.id,
    ...values,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    return { success: false, message: "Failed to save. Please try again." };
  }

  revalidatePath("/dashboard/profile");

  return { success: true, message: "Business profile saved." };
}