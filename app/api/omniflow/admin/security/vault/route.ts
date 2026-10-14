import { createClient } from "../../../../../../lib/supabase/server";
import { getAdminVault } from "../../../../../../lib/omniflow/admin-control-plane";
import { adminBridgeError } from "../../../../../../lib/omniflow/admin-bridge-error";
import {
  noStoreHeaders,
  safeJson,
  sameOrigin,
} from "../../../../../../lib/omniflow/request-security";

export async function GET(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson({ error: { code: "forbidden", message: "Request origin was rejected." } }, 403);
  }
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return safeJson({ error: { code: "unauthorized", message: "Admin sign in required." } }, 401);
  }
  try {
    return safeJson(await getAdminVault(), 200);
  } catch (failure) {
    const bridge = adminBridgeError(failure);
    if (bridge) return bridge;
    return safeJson(
      { error: { code: "vault_unavailable", message: "Could not read the encryption status. Please try again." } },
      503
    );
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
