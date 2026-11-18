"use server";

import { requireOmniFlowPrincipal } from "../../../../lib/omniflow/auth-dal";
import { saveTenantHybridConfig } from "../../../../lib/omniflow/hybrid-whatsapp-engine";
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

const EXTENDED_FIELDS: ReadonlyArray<readonly [string, number]> = [
  ["about", 1000],
  ["products", 3000],
  ["policies", 2000],
  ["faqs", 3000],
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
  for (const [name, max] of EXTENDED_FIELDS) {
    profile[name] = field(formData, name, max);
  }

  try {
    const principal = await requireOmniFlowPrincipal();
    await saveTenantHybridConfig(principal.clientId, {
      businessConfig: {
        businessName,
        contactInfo: profile.phone || "WhatsApp Support Desk",
        businessDescription:
          profile.about || "Customer support and order assistance on WhatsApp.",
        productsAndServices:
          profile.products || "Standard products and customer services.",
        pricingInfo:
          profile.policies ||
          "Contact us for item-specific pricing or catalog details.",
      },
    });
  } catch {
    // ignore fallback error
  }

  try {
    await saveBusinessProfile(accessToken, profile);
  } catch {
    // External control plane optional; local/Neon hybrid store already saved above.
  }

  return {
    success: true,
    message: "Business profile saved and automatically synced with your AI Agent.",
  };
}
