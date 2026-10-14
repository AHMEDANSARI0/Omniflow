import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  extractKbFile,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

// §219: PDF / Word text for the owner to review. §221: images and scanned
// PDF pages are read with the platform vision AI when the owner asks
// (`ocr: true` + `pages`, a few pages per request). The Control Plane
// enforces the real limits (OF_KB_FILE_BYTES_MAX, OF_KB_OCR_PAGES_PER_CALL);
// these ceilings only stop absurd bodies before they are forwarded.
const FILE_TYPES = [".pdf", ".docx", ".jpg", ".jpeg", ".png", ".webp"];
const MAX_BASE64_CHARS = 70_000_000;
const MAX_OCR_PAGES = 10;

// AI page reading takes several seconds per page.
export const maxDuration = 60;

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    filename?: unknown;
    file_base64?: unknown;
    ocr?: unknown;
    pages?: unknown;
  } | null;
  const filename =
    payload && typeof payload.filename === "string"
      ? payload.filename.trim().slice(0, 200)
      : "";
  const fileBase64 =
    payload && typeof payload.file_base64 === "string" ? payload.file_base64 : "";
  const lower = filename.toLowerCase();
  if (!filename || !FILE_TYPES.some((ext) => lower.endsWith(ext))) {
    return safeJson(
      {
        error: {
          code: "unsupported_type",
          message: "Only PDF, Word (.docx) and image (JPG, PNG, WebP) files can be imported.",
        },
      },
      400
    );
  }
  if (!fileBase64) {
    return safeJson(
      { error: { code: "bad_request", message: "No file was received." } },
      400
    );
  }
  if (fileBase64.length > MAX_BASE64_CHARS) {
    return safeJson(
      { error: { code: "too_large", message: "That file is too large." } },
      413
    );
  }

  let ocr: { pages: number[] } | undefined;
  if (payload?.ocr === true) {
    const pages = Array.isArray(payload.pages) ? payload.pages : [];
    if (
      pages.length === 0 ||
      pages.length > MAX_OCR_PAGES ||
      !pages.every((page) => Number.isInteger(page) && page >= 1)
    ) {
      return safeJson(
        { error: { code: "bad_request", message: "Choose the pages to read." } },
        400
      );
    }
    ocr = { pages: pages as number[] };
  }

  try {
    const result = await extractKbFile(accessToken, filename, fileBase64, ocr);
    if (result.kind === "unavailable") {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result.kind === "invalid") {
      return safeJson(
        { error: { code: result.code, message: result.message } },
        result.status
      );
    }
    return safeJson(result.file, 200);
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
