"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "../../../../lib/supabase/server";

export interface BotActionState {
  success: boolean;
  message: string;
}

export async function updateBotSettings(
  _prevState: BotActionState,
  formData: FormData
): Promise<BotActionState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  const values = {
    bot_name: String(formData.get("bot_name") ?? "").trim(),
    is_active: formData.get("is_active") === "on",
    welcome_message: String(formData.get("welcome_message") ?? "").trim(),
    instructions: String(formData.get("instructions") ?? "").trim(),
    tone: String(formData.get("tone") ?? "friendly").trim(),
    fallback_message: String(formData.get("fallback_message") ?? "").trim(),
  };

  if (!values.bot_name || !values.welcome_message) {
    return {
      success: false,
      message: "Bot name and welcome message are required.",
    };
  }

  const { error } = await supabase.from("bot_settings").upsert({
    id: user.id,
    ...values,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    return { success: false, message: "Failed to save. Please try again." };
  }

  revalidatePath("/dashboard/bot");

  return { success: true, message: "Bot settings saved." };
}