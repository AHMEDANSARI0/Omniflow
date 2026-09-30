import {
  getMediaAiSettings,
  saveMediaAiSettings,
  type MediaAiSettings,
} from "../../../../../../lib/omniflow/portal";
import {
  jsonBody,
  serviceResponse,
  withPortalToken,
} from "../../../../../../lib/omniflow/voice-vision-bff";

/** Customer voice note / image understanding switches (D5). */
export async function GET() {
  return withPortalToken(async (token) =>
    serviceResponse(await getMediaAiSettings(token))
  );
}

export async function PUT(request: Request) {
  return withPortalToken(async (token) => {
    const body = await jsonBody(request);
    const raw = (body.settings && typeof body.settings === "object"
      ? body.settings
      : body) as Record<string, unknown>;
    const settings: Partial<MediaAiSettings> = {};
    if (typeof raw.voice_notes === "boolean") settings.voice_notes = raw.voice_notes;
    if (typeof raw.images === "boolean") settings.images = raw.images;
    return serviceResponse(await saveMediaAiSettings(token, settings));
  }, request);
}
