import "server-only";

import type { NextResponse } from "next/server";

import { ControlPlaneRequestError } from "./control-plane";
import { safeJson } from "./request-security";

// Batch 245: one mapping for every admin BFF route. A missing website env value
// or a service key the Control Plane rejects used to surface as each route's
// generic "Could not load ..." - now the admin sees what to fix. Anything else
// returns null so the route keeps its own fallback message.
const NOT_CONFIGURED = new Set([
  "service_not_configured",
  "control_plane_not_configured",
  "control_plane_url_invalid",
  "control_plane_tls_required",
]);

export const SERVICE_KEY_REJECTED_MESSAGE =
  "The Control Plane rejected the service key. OMNIFLOW_SERVICE_KEY on the website must match " +
  "OMNIFLOW_SERVICE_KEY (or OMNIFLOW_ADMIN_API_KEY) on the Control Plane - paste the same value " +
  "in both projects and redeploy both.";

export function adminBridgeError(error: unknown): NextResponse | null {
  if (!(error instanceof ControlPlaneRequestError)) return null;
  if (NOT_CONFIGURED.has(error.code)) {
    return safeJson(
      {
        error: {
          code: error.code,
          message:
            "Admin bridge not configured - set OMNIFLOW_SERVICE_KEY and an https " +
            "OMNIFLOW_CONTROL_PLANE_URL on the website project, then redeploy.",
        },
      },
      503
    );
  }
  if (error.code === "service_key_rejected") {
    return safeJson(
      { error: { code: "service_key_rejected", message: SERVICE_KEY_REJECTED_MESSAGE } },
      503
    );
  }
  return null;
}
