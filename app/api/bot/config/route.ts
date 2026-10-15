import { NextResponse } from "next/server";

/**
 * §276 — DEPRECATED / removed. This endpoint served the legacy website-hosted
 * bot from Supabase tables (`bot_settings`, `business_profiles`) that no longer
 * exist. Bots now read configuration and exchange messages through the
 * OmniFlow Control Plane (`/api/v1/connector/whatsapp/*`). Kept as 410 Gone so
 * an old client gets a clear, honest signal instead of a hang or a 500.
 */
export async function GET() {
  return NextResponse.json(
    {
      error: "gone",
      message:
        "This endpoint has been removed. Use the OmniFlow Control Plane connector API (/api/v1/connector/whatsapp/*).",
    },
    { status: 410 }
  );
}
