"use server";

import { getOmniFlowSession } from "../../../../lib/omniflow/auth-dal";

export interface BotActionState {
  success: boolean;
  message: string;
}

export async function updateBotSettings(
  _previousState: BotActionState,
  _formData: FormData
): Promise<BotActionState> {
  void _previousState;
  void _formData;
  const session = await getOmniFlowSession();
  if (session.kind !== "authenticated") {
    return { success: false, message: "Your secure session is not active." };
  }

  return {
    success: false,
    message: "AI-agent updates are waiting for the tenant-scoped Control Plane endpoint.",
  };
}
