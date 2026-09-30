import { controlPlaneBaseUrl } from "./portal";

/**
 * Raw binary fetch for a stored media asset (the JSON helper in
 * portal.ts always parses JSON, so downloads use this instead).
 * Returns null on transport errors; non-2xx responses are returned
 * as-is for the caller to map.
 */
export async function portalAssetDownload(
  accessToken: string,
  assetId: number
): Promise<Response | null> {
  const url = new URL(
    "api/v1/portal/media/" + assetId + "/download",
    controlPlaneBaseUrl()
  );
  try {
    return await fetch(url, {
      headers: {
        Accept: "*/*",
        Authorization: `Bearer ${accessToken}`,
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    return null;
  }
}

/**
 * §214: raw bytes of a customer image / voice note from the media store
 * (stored copy, provider link or a refreshed Instagram link - the Control
 * Plane decides). Same contract as portalAssetDownload.
 */
export async function portalInboundMediaContent(
  accessToken: string,
  mediaId: number
): Promise<Response | null> {
  const url = new URL(
    "api/v1/portal/inbound-media/" + mediaId + "/content",
    controlPlaneBaseUrl()
  );
  try {
    return await fetch(url, {
      headers: {
        Accept: "image/*, audio/*",
        Authorization: `Bearer ${accessToken}`,
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    return null;
  }
}
