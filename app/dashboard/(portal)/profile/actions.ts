"use server";

import { getOmniFlowSession } from "../../../../lib/omniflow/auth-dal";

export interface ProfileActionState {
  success: boolean;
  message: string;
}

export async function updateBusinessProfile(
  _previousState: ProfileActionState,
  _formData: FormData
): Promise<ProfileActionState> {
  void _previousState;
  void _formData;
  const session = await getOmniFlowSession();
  if (session.kind !== "authenticated") {
    return { success: false, message: "Your secure session is not active." };
  }

  return {
    success: false,
    message: "Business-profile updates are waiting for the tenant-scoped Control Plane endpoint.",
  };
}
