import "server-only";

import { NextResponse } from "next/server";


export const MAX_AUTH_BODY_BYTES = 16 * 1024;

export function noStoreHeaders(): HeadersInit {
  return {
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
  };
}

export function safeJson(
  payload: unknown,
  status = 200
): NextResponse {
  return NextResponse.json(payload, {
    status,
    headers: noStoreHeaders(),
  });
}

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return false;

  try {
    const requestUrl = new URL(request.url);
    const originUrl = new URL(origin);
    const forwardedHost = request.headers
      .get("x-forwarded-host")
      ?.split(",", 1)[0]
      .trim();
    const forwardedProtocol = request.headers
      .get("x-forwarded-proto")
      ?.split(",", 1)[0]
      .trim();
    const expectedHost =
      forwardedHost || request.headers.get("host") || requestUrl.host;
    const expectedProtocol =
      forwardedProtocol || requestUrl.protocol.replace(/:$/, "");

    return (
      originUrl.host === expectedHost &&
      originUrl.protocol === `${expectedProtocol}:`
    );
  } catch {
    return false;
  }
}

export async function readJsonObject(
  request: Request
): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return null;
  }

  const declared = request.headers.get("content-length");
  if (declared) {
    const length = Number(declared);
    if (!Number.isInteger(length) || length <= 0 || length > MAX_AUTH_BODY_BYTES) {
      return null;
    }
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return null;
  }

  if (raw.length === 0 || Buffer.byteLength(raw, "utf8") > MAX_AUTH_BODY_BYTES) {
    return null;
  }

  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}
