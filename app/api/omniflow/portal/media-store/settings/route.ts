import {
  getMediaStoreSettings,
  saveMediaStoreSettings,
  type MediaStoreSettings,
} from "../../../../../../lib/omniflow/portal";
import {
  jsonBody,
  serviceResponse,
  withPortalToken,
} from "../../../../../../lib/omniflow/voice-vision-bff";

/** §214: customer file copies - keep switch, retention days, storage limit. */
export async function GET() {
  return withPortalToken(async (token) =>
    serviceResponse(await getMediaStoreSettings(token))
  );
}

export async function PUT(request: Request) {
  return withPortalToken(async (token) => {
    const body = await jsonBody(request);
    const raw = (body.settings && typeof body.settings === "object"
      ? body.settings
      : body) as Record<string, unknown>;
    const settings: Partial<MediaStoreSettings> = {};
    if (typeof raw.keep_copies === "boolean") settings.keep_copies = raw.keep_copies;
    if (typeof raw.retention_days === "number") settings.retention_days = raw.retention_days;
    if (typeof raw.quota_mb === "number") settings.quota_mb = raw.quota_mb;
    return serviceResponse(await saveMediaStoreSettings(token, settings));
  }, request);
}
