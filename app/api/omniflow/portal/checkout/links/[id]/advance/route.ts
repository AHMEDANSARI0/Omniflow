import { ControlPlaneRequestError } from "../../../../../../../../lib/omniflow/control-plane";
import {
  addCheckoutAdvance,
  requirePortalAccessToken,
} from "../../../../../../../../lib/omniflow/portal";
import {
  safeJson,
} from "../../../../../../../../lib/omniflow/request-security";

function parseId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id >= 1 ? id : null;
}


export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await context.params;
  const linkId = parseId(id);
  if (linkId === null) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid link id." } },
      400
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const input =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const amount = Math.round(Number(input.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Enter an amount greater than zero." } },
      400
    );
  }

  try {
    const result = await addCheckoutAdvance(accessToken, linkId, amount);
    if (result === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Only open links can take an advance." } },
        404
      );
    }
    if (result === "bad_request") {
      return safeJson(
        { error: { code: "bad_request", message: "The amount is invalid." } },
        400
      );
    }
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(
      {
        ok: true,
        paid_amount: result.paidAmount,
        due: result.due,
        status: result.status,
      },
      200
    );
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
