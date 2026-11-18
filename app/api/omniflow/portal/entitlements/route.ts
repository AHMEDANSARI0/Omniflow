import { authorizePortalOperation } from "../../../../../lib/omniflow/authz";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../lib/omniflow/request-security";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const requestedClientId = url.searchParams.get("clientId")
    ? Number(url.searchParams.get("clientId"))
    : null;

  const auth = await authorizePortalOperation({
    requestedClientId,
  });

  if (!auth.ok) {
    return auth.response;
  }

  return safeJson(
    {
      entitlements: auth.entitlements,
    },
    200
  );
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
