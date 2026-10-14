import type { AbInput } from "./portal";

/** Upper bounds the Control Plane also enforces (it has the final say). */
export const AB_MAX_VERSIONS = 4;
export const AB_MAX_BODY = 1000;

function whole(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

/**
 * Browser body -> AbInput, or an error message. Only shape and size are
 * checked here; the Control Plane validates ranges, audience and duplicates.
 */
export function abInputFromBody(body: Record<string, unknown>): AbInput | string {
  const raw = body.variants;
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > AB_MAX_VERSIONS) {
    return "Give 2 to " + String(AB_MAX_VERSIONS) + " message versions.";
  }
  const variants: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim() || item.length > AB_MAX_BODY) {
      return "Every version needs text (up to " + String(AB_MAX_BODY) + " characters).";
    }
    variants.push(item.trim());
  }
  const audience = typeof body.audience === "string" ? body.audience.trim() : "all";
  if (!/^(all|open|hot|segment:[0-9]{1,18})$/.test(audience)) {
    return "Pick an audience.";
  }
  return {
    name: typeof body.name === "string" ? body.name.slice(0, 80) : "",
    audience,
    variants,
    testPercent: whole(body.testPercent, 30),
    decideHours: whole(body.decideHours, 24),
    metric: body.metric === "order" ? "order" : "reply",
    autoWinner: body.autoWinner === true,
  };
}
