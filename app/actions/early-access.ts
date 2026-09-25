"use server";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

export interface EarlyAccessState {
  success: boolean;
  message: string;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function submitEarlyAccess(
  _prevState: EarlyAccessState,
  formData: FormData
): Promise<EarlyAccessState> {
  // Honeypot — bots fill hidden fields; humans never see it
  if (String(formData.get("website") ?? "").length > 0) {
    return { success: true, message: "Thanks — you're on the list!" };
  }

  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const company = String(formData.get("company") ?? "").trim();

  if (name.length < 2) {
    return { success: false, message: "Please enter your name." };
  }
  if (!EMAIL_REGEX.test(email)) {
    return { success: false, message: "Please enter a valid email address." };
  }

  const supabase = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } }
  );

  const { error } = await supabase.from("leads").insert({
    name,
    email,
    company: company || null,
  });

  if (error) {
    // Unique violation — email already registered
    if (error.code === "23505") {
      return {
        success: true,
        message: "You're already on the list — we'll be in touch!",
      };
    }
    return { success: false, message: "Something went wrong. Please try again." };
  }

  return {
    success: true,
    message: "Thanks — you're on the list! We'll reach out soon.",
  };
}