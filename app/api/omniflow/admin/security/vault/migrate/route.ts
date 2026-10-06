import { createClient } from "../../../../../../../lib/supabase/server";
import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import { migrateAdminVault } from "../../../../../../../lib/omniflow/admin-control-plane";
import { adminBridgeError } from "../../../../../../../lib/omniflow/admin-bridge-error";
import {
  noStoreHeaders,
  safeJson,
  sameOrigin,
} from "../../../../../../../lib/omniflow/request-security";

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson({ error: { code: "forbidden", message: "Request origin was rejected." } }, 403);
  }
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return safeJson({ error: { code: "unauthorized", message: "Admin sign in required." } }, 401);
  }
  try {
    return safeJson(await migrateAdminVault(), 200);
  } catch (failure) {
    const bridge = adminBridgeError(failure);
    if (bridge) return bridge;
    if (failure instanceof ControlPlaneRequestError) {
      if (failure.status === 409) {
        return safeJson(
          {
            error: {
              code: "vault_not_configured",
              message:
                "Encryption is not active on the Control Plane yet — add OF_SECRETS_KEY (32+ characters) to its environment and redeploy.",
            },
          },
          409
        );
      }
    }
    return safeJson(
      { error: { code: "vault_unavailable", message: "Could not encrypt the stored secrets. Please try again." } },
      503
    );
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
