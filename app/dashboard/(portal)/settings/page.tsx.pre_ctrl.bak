import { redirect } from "next/navigation";
import ApiKeyCard from "./ApiKeyCard";
import {
  getApiKeyInfo,
  requirePortalAccessToken,
} from "../../../../lib/omniflow/portal";


export const dynamic = "force-dynamic";

export default async function ClientSettingsPage() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) redirect("/dashboard/login");

  let keyInfo: {
    key_prefix: string;
    revoked: boolean;
    created_at: string;
    last_used_at: string | null;
  } | null = null;

  try {
    const info = await getApiKeyInfo(accessToken);
    if (info.configured) {
      keyInfo = {
        key_prefix: info.keyPrefix ?? "ofk_",
        revoked: info.revoked,
        created_at: info.createdAt ?? "",
        last_used_at: info.lastUsedAt,
      };
    }
  } catch {
    keyInfo = null;
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Settings
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Workspace security and integration controls for your tenant.
        </p>
      </div>

      <ApiKeyCard keyInfo={keyInfo} />
    </div>
  );
}
