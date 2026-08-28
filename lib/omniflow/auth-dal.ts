import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import {
  ControlPlaneRequestError,
  getControlPlanePrincipal,
  type OmniFlowPrincipal,
} from "./control-plane";
import { readSessionCookies } from "./session-cookies";


export type OmniFlowSessionState =
  | { kind: "authenticated"; principal: OmniFlowPrincipal }
  | { kind: "refresh_required" }
  | { kind: "unauthenticated" }
  | { kind: "unavailable" };

export const getOmniFlowSession = cache(
  async (): Promise<OmniFlowSessionState> => {
    const { accessToken, refreshToken } = await readSessionCookies();

    if (!accessToken) {
      return refreshToken
        ? { kind: "refresh_required" }
        : { kind: "unauthenticated" };
    }

    try {
      return {
        kind: "authenticated",
        principal: await getControlPlanePrincipal(accessToken),
      };
    } catch (error) {
      if (error instanceof ControlPlaneRequestError) {
        if (error.isUnauthorized) {
          return refreshToken
            ? { kind: "refresh_required" }
            : { kind: "unauthenticated" };
        }
        if (error.status >= 500) return { kind: "unavailable" };
      }
      return { kind: "unavailable" };
    }
  }
);

export async function requireOmniFlowPrincipal(): Promise<OmniFlowPrincipal> {
  const state = await getOmniFlowSession();
  if (state.kind === "unauthenticated") redirect("/dashboard/login");
  if (state.kind === "refresh_required") redirect("/dashboard/reauth");
  if (state.kind === "unavailable") redirect("/dashboard/unavailable");
  return state.principal;
}
