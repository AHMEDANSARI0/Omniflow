"use server";

import { randomBytes, createHash } from "crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "../../../../lib/supabase/server";

export interface ApiKeyActionState {
  success: boolean;
  message: string;
  /** Plaintext key — shown ONCE right after generation */
  newKey?: string;
}

export async function generateApiKey(
  _prevState: ApiKeyActionState,
  _formData: FormData
): Promise<ApiKeyActionState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  const key = `ofk_${randomBytes(24).toString("hex")}`;
  const keyHash = createHash("sha256").update(key).digest("hex");
  const keyPrefix = key.slice(0, 12);

  const { error } = await supabase.from("api_keys").upsert({
    user_id: user.id,
    key_hash: keyHash,
    key_prefix: keyPrefix,
    revoked: false,
    created_at: new Date().toISOString(),
    last_used_at: null,
  });

  if (error) {
    return { success: false, message: "Failed to generate key. Try again." };
  }

  revalidatePath("/dashboard/settings");

  return {
    success: true,
    message:
      "API key generated. Copy it now — it will not be shown again.",
    newKey: key,
  };
}

export async function revokeApiKey(
  _prevState: ApiKeyActionState,
  _formData: FormData
): Promise<ApiKeyActionState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  const { error } = await supabase
    .from("api_keys")
    .update({ revoked: true })
    .eq("user_id", user.id);

  if (error) {
    return { success: false, message: "Failed to revoke key." };
  }

  revalidatePath("/dashboard/settings");

  return { success: true, message: "API key revoked. Your bot is disconnected." };
}