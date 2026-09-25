import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  bookCourierParcel,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const city =
    payload && typeof payload.city === "string" ? payload.city : "";
  const address =
    payload && typeof payload.address === "string" ? payload.address : "";
  if (!city.trim() || !address.trim()) {
    return safeJson(
      {
        error: { code: "bad_request", message: "city and address are"
                                                 + " required." },
      },
      400
    );
  }

  try {
    const result = await bookCourierParcel(accessToken, {
      contact_id:
        typeof payload?.contact_id === "string" ? payload.contact_id : "",
      customer_name:
        typeof payload?.customer_name === "string"
          ? payload.customer_name
          : "",
      phone: typeof payload?.phone === "string" ? payload.phone : "",
      city,
      address,
      cod_amount:
        typeof payload?.cod_amount === "number"
          ? payload.cod_amount
          : 0,
      pieces: typeof payload?.pieces === "number" ? payload.pieces : 1,
      description:
        typeof payload?.description === "string"
          ? payload.description
          : "",
    });
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(result, 200);
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
