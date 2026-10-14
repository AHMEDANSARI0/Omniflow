import {
  getVoiceAiSettings,
  saveVoiceAiSettings,
  type VoiceAiSettings,
} from "../../../../../../lib/omniflow/portal";
import {
  jsonBody,
  serviceResponse,
  withPortalToken,
} from "../../../../../../lib/omniflow/voice-vision-bff";

/** Phone assistant settings for the signed-in workspace (D5). */
export async function GET() {
  return withPortalToken(async (token) =>
    serviceResponse(await getVoiceAiSettings(token))
  );
}

const TEXT_KEYS = ["greeting", "handoff_message", "language", "speech_model",
  "tts_voice", "forward_to"] as const;

export async function PUT(request: Request) {
  return withPortalToken(async (token) => {
    const body = await jsonBody(request);
    const raw = (body.settings && typeof body.settings === "object"
      ? body.settings
      : body) as Record<string, unknown>;
    const settings: Partial<VoiceAiSettings> = {};
    if (typeof raw.enabled === "boolean") settings.enabled = raw.enabled;
    for (const key of TEXT_KEYS) {
      if (typeof raw[key] === "string") {
        settings[key] = String(raw[key]).slice(0, 220);
      }
    }
    if (raw.max_turns !== undefined) settings.max_turns = Number(raw.max_turns);
    return serviceResponse(await saveVoiceAiSettings(token, settings));
  }, request);
}
