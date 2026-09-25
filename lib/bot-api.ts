import { createHash } from "crypto";
import { createServiceClient } from "./supabase/service";

/**
 * Authenticates a Bot API request via `Authorization: Bearer ofk_...`.
 * Returns the owning user's id, or null if the key is invalid/revoked.
 */
export async function authenticateApiKey(
  request: Request
): Promise<string | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(ofk_[a-f0-9]{48})$/i);
  if (!match) return null;

  const keyHash = createHash("sha256").update(match[1]).digest("hex");

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("api_keys")
    .select("user_id, revoked")
    .eq("key_hash", keyHash)
    .single();

  if (error || !data || data.revoked) return null;

  // Update last_used_at (best-effort, non-blocking)
  void supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("key_hash", keyHash)
    .then(() => undefined);

  return data.user_id as string;
}