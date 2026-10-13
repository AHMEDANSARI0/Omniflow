import { NextResponse } from "next/server";

/**
 * §276 — DEPRECATED / removed. The legacy website bot pushed messages here into
 * Supabase tables (`conversations`, `conversation_messages`) that no longer
 * exist. Conversations now flow through the OmniFlow Control Plane. Kept as
 * 410 Gone so an old client gets a clear, honest signal instead of a 500.
 */
export async function POST() {
  return NextResponse.json(
    {
      error: "gone",
      message:
        "This endpoint has been removed. Use the OmniFlow Control Plane connector API (/api/v1/connector/whatsapp/*).",
    },
    { status: 410 }
  );
}
