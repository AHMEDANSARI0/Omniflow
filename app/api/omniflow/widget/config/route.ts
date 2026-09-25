import { safeJson } from "../../../../../lib/omniflow/request-security";
import { widgetControlPlaneFetch } from "../../../../../lib/omniflow/widget-transport";

export async function GET() {
  try {
    const response = await widgetControlPlaneFetch("/api/v1/widget/config");
    if (!response || !response.ok) {
      return safeJson({ enabled: false }, 200);
    }
    const data = (await response.json().catch(() => null)) as unknown;
    if (data === null || typeof data !== "object") {
      return safeJson({ enabled: false }, 200);
    }
    return safeJson(data, 200);
  } catch {
    return safeJson({ enabled: false }, 200);
  }
}
