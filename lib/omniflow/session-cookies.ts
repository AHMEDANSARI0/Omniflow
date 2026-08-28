import "server-only";

import { cookies } from "next/headers";
import type { OmniFlowSessionTokens } from "./control-plane";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  SESSION_COOKIE_NAMES,
} from "./session-constants";


const secure = process.env.NODE_ENV === "production";

function validExpiry(value: string): Date {
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) {
    throw new Error("Invalid session expiry");
  }
  return result;
}

export async function readSessionCookies(): Promise<{
  accessToken: string | null;
  refreshToken: string | null;
}> {
  const store = await cookies();
  return {
    accessToken: store.get(ACCESS_COOKIE)?.value ?? null,
    refreshToken: store.get(REFRESH_COOKIE)?.value ?? null,
  };
}

export async function writeSessionCookies(
  session: OmniFlowSessionTokens
): Promise<void> {
  const store = await cookies();
  const shared = {
    httpOnly: true,
    secure,
    sameSite: "strict" as const,
    path: "/",
    priority: "high" as const,
  };

  store.set(ACCESS_COOKIE, session.accessToken, {
    ...shared,
    expires: validExpiry(session.accessExpiresAt),
  });
  store.set(REFRESH_COOKIE, session.refreshToken, {
    ...shared,
    expires: validExpiry(session.refreshExpiresAt),
  });
}

export async function clearSessionCookies(): Promise<void> {
  const store = await cookies();
  for (const name of SESSION_COOKIE_NAMES) {
    store.set(name, "", {
      httpOnly: true,
      secure,
      sameSite: "strict",
      path: "/",
      expires: new Date(0),
      maxAge: 0,
      priority: "high",
    });
  }
}
