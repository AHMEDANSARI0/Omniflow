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
