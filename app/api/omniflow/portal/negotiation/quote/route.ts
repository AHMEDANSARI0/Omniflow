import {
  getNegotiationQuote,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";


export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const params = new URL(request.url).searchParams;
  const ask = Number(params.get("ask"));
  const price = Number(params.get("price"));
  if (!Number.isFinite(ask) || ask <= 0 || !Number.isFinite(price) || price <= 0) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "ask and price must be positive numbers.",
        },
      },
      400
    );
  }

  try {
    const quote = await getNegotiationQuote(accessToken, ask, price);
    if (quote === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(quote, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
