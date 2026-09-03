"use server";

import { ControlPlaneRequestError } from "../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  saveBusinessProfile,
} from "../../../../lib/omniflow/portal";

export interface ProfileActionState {
  success: boolean;
  message: string;
}

const OPTIONAL_FIELDS = [
  "industry",
  "phone",
  "website",
  "address",
  "timezone",
  "business_hours",
  "default_language",
] as const;

function field(formData: FormData, name: string, max: number): string {
  const raw = formData.get(name);
  const value = typeof raw === "string" ? raw.trim().slice(0, max) : "";
  return value;
}

export async function updateBusinessProfile(
  _previousState: ProfileActionState,
  formData: FormData
): Promise<ProfileActionState> {
  void _previousState;

  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return { success: false, message: "Your secure session is not active." };
  }

  const businessName = field(formData, "business_name", 200);
  if (!businessName) {
    return { success: false, message: "Business name is required." };
  }

  const profile: Record<string, string> = { business_name: businessName };
  for (const name of OPTIONAL_FIELDS) {
    profile[name] = field(formData, name, 500);
  }

  try {
    const result = await saveBusinessProfile(accessToken, profile);
    if (!result.configured) {
      return {
        success: false,
        message:
          "The profile module is still rolling out on the server — try again shortly.",
      };
    }
    if (!result.ok) {
      return {
        success: false,
        message: result.message ?? "The profile could not be saved.",
      };
    }
    return { success: true, message: "Profile saved." };
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return { success: false, message: "Your session expired — reload the page." };
    }
    return { success: false, message: "Network error — please try again." };
  }
}
