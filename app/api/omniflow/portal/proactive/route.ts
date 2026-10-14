import { getProactive, saveProactive } from "../../../../../lib/omniflow/portal";
import type { ProactiveChange } from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";
import { jsonBody, serviceResponse, withPortalToken } from "../../../../../lib/omniflow/voice-vision-bff";

const KEY = /^[a-z_]{1,40}$/;

function bad(message: string) {
  return safeJson({ error: { code: "bad_request", message } }, 400);
}

/** §242 proactive alerts: rules, their limits and the recent alerts. */
export async function GET() {
  return withPortalToken(async (accessToken) => serviceResponse(await getProactive(accessToken)));
}

/** Owners / admins only (the Control Plane enforces roles and ranges). */
export async function PUT(request: Request) {
  return withPortalToken(async (accessToken) => {
    const body = await jsonBody(request);
    const change: ProactiveChange = {};
    if ("enabled" in body) {
      if (typeof body.enabled !== "boolean") return bad("enabled must be true or false.");
      change.enabled = body.enabled;
    }
    if ("rules" in body) {
      const rules = body.rules;
      if (rules === null || typeof rules !== "object" || Array.isArray(rules)) return bad("rules must be an object.");
      change.rules = {};
      for (const [key, raw] of Object.entries(rules as Record<string, unknown>).slice(0, 20)) {
        if (!KEY.test(key) || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
          return bad("Each rule needs a known key and an object of settings.");
        }
        const clean: Record<string, boolean | number> = {};
        for (const [name, value] of Object.entries(raw as Record<string, unknown>).slice(0, 10)) {
          if (!KEY.test(name) || !(typeof value === "boolean" || Number.isInteger(value))) {
            return bad("Settings must be true / false or whole numbers.");
          }
          clean[name] = value as boolean | number;
        }
        change.rules[key] = clean;
      }
    }
    return serviceResponse(await saveProactive(accessToken, change));
  }, request);
}
