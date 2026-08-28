"use server";

import { getOmniFlowSession } from "../../../../lib/omniflow/auth-dal";

export interface ApiKeyActionState {
  success: boolean;
  message: string;
  newKey?: string;
}

async function pendingState(): Promise<ApiKeyActionState> {
  const session = await getOmniFlowSession();
  if (session.kind !== "authenticated") {
    return { success: false, message: "Your secure session is not active." };
  }

  return {
    success: false,
    message: "Legacy client-bot API keys are disabled; managed connector controls are coming next.",
  };
}

export async function generateApiKey(
  _previousState: ApiKeyActionState,
  _formData: FormData
): Promise<ApiKeyActionState> {
  void _previousState;
  void _formData;
  return pendingState();
}

export async function revokeApiKey(
  _previousState: ApiKeyActionState,
  _formData: FormData
): Promise<ApiKeyActionState> {
  void _previousState;
  void _formData;
  return pendingState();
}
