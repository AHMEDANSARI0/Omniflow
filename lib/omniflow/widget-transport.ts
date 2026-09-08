/**
 * Server-side transport for the public website chat widget. The widget has
 * no portal session, so these calls carry no bearer token — the Control
 * Plane widget endpoints are public by design. Same TLS hygiene as the
 * authenticated portal transport.
 */

export function widgetControlPlaneUrl(path: string): string {
  const raw = process.env.OMNIFLOW_CONTROL_PLANE_URL?.trim();
  if (!raw) throw new Error("control_plane_not_configured");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("control_plane_url_invalid");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("control_plane_url_invalid");
  }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("control_plane_tls_required");
  }

  return url.origin + url.pathname.replace(/\/$/, "") + path;
}

export async function widgetControlPlaneFetch(
  path: string,
  init?: RequestInit
): Promise<Response | null> {
  try {
    return await fetch(widgetControlPlaneUrl(path), {
      ...init,
      cache: "no-store",
    });
  } catch {
    return null;
  }
}
