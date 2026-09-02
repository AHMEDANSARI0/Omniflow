"use server";

import { ControlPlaneRequestError } from "../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  revokeApiKey as revokeApiKeyRequest,
  rotateApiKey,
} from "../../../../lib/omniflow/portal";

export interface ApiKeyActionState {
  success: boolean;
  message: string;
  newKey?: string;
}

export async function generateApiKey(
  _previousState: ApiKeyActionState,
  _formData: FormData
): Promise<ApiKeyActionState> {
  void _previousState;
  void _formData;

  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return { success: false, message: "Your secure session is not active." };
  }

  try {
    const result = await rotateApiKey(accessToken);
    if (!result.ok) {
      return {
        success: false,
        message: result.message ?? "The key could not be generated.",
      };
    }
    return {
      success: true,
      message:
        "New API key generated — copy it now, it will not be shown again.",
      newKey: result.key ?? undefined,
    };
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return { success: false, message: "Your session expired — reload the page." };
    }
    return { success: false, message: "Network error — please try again." };
  }
}

export async function revokeApiKey(
  _previousState: ApiKeyActionState,
  _formData: FormData
): Promise<ApiKeyActionState> {
  void _previousState;
  void _formData;

  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return { success: false, message: "Your secure session is not active." };
  }

  try {
    const result = await revokeApiKeyRequest(accessToken);
    if (!result.ok) {
      return {
        success: false,
        message: result.message ?? "The key could not be revoked.",
      };
    }
    return { success: true, message: "API key revoked." };
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return { success: false, message: "Your session expired — reload the page." };
    }
    return { success: false, message: "Network error — please try again." };
  }
}
