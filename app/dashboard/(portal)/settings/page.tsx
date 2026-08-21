import { createClient } from "../../../../lib/supabase/server";
import ApiKeyCard, { type ApiKeyInfo } from "./ApiKeyCard";

export default async function ClientSettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data } = await supabase
    .from("api_keys")
    .select("key_prefix, revoked, created_at, last_used_at")
    .eq("user_id", user!.id)
    .single();

  const keyInfo: ApiKeyInfo | null = data
    ? {
        key_prefix: data.key_prefix as string,
        revoked: data.revoked as boolean,
        created_at: data.created_at as string,
        last_used_at: (data.last_used_at as string | null) ?? null,
      }
    : null;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Settings
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          API access for connecting your bot to OmniFlow.
        </p>
      </div>

      <ApiKeyCard keyInfo={keyInfo} />
    </div>
  );
}