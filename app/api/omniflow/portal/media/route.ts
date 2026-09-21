import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  listMediaAssets,
  requirePortalAccessToken,
  uploadMediaAsset,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const payload = await listMediaAssets(accessToken);
    if (payload === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(payload, 200);
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

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return safeJson(
      { error: { code: "bad_request", message: "multipart form is"
                                             + " required." } },
      400
    );
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return safeJson(
      { error: { code: "bad_request", message: "file is required." } },
      400
    );
  }
  if (file.size > 8 * 1024 * 1024) {
    return safeJson(
      { error: { code: "bad_request", message: "File is larger than"
                                               + " 8 MB." } },
      400
    );
  }

  const forward = new FormData();
  forward.set("file", file, file.name);
  const caption = form.get("caption");
  if (typeof caption === "string" && caption.trim()) {
    forward.set("caption", caption.trim());
  }

  try {
    const payload = await uploadMediaAsset(accessToken, forward);
    if (payload === null) {
      return safeJson(
        {
          error: {
            code: "portal_unavailable",
            message: "Upload failed - check the file type (images, PDF"
                     + " or audio) and the 8 MB limit.",
          },
        },
        502
      );
    }
    return safeJson(payload, 200);
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
