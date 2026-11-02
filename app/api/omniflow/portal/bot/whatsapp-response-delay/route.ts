import { NextRequest, NextResponse } from "next/server";
import { BotConfig, DEFAULT_BOT_CONFIG } from "../../../../../../lib/omniflow/portal";

// In-memory store for per-client delays (dev only - use DB for production)
export const clientDelays = new Map<string, number>();

/**
 * GET /api/v1/omniflow/portal/bot/whatsapp-response-delay?client_id=<id>
 * Returns per-client response delay in seconds.
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const clientId = searchParams.get("client_id");

  if (!clientId) {
    return NextResponse.json(
      { error: "client_id is required" },
      { status: 400 },
    );
  }

  // Return stored delay for this client, or default 0
  const delaySeconds = clientDelays.get(clientId) ?? DEFAULT_BOT_CONFIG.responseDelaySeconds;

  return NextResponse.json({
    client_id: clientId,
    responseDelaySeconds: delaySeconds,
  });
}

/**
 * POST /api/v1/omniflow/portal/bot/whatsapp-response-delay
 * Set delay for a specific client.
 * Body: { client_id: "1", responseDelaySeconds: 120 }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { client_id, responseDelaySeconds } = body;

    if (!client_id) {
      return NextResponse.json(
        { error: "client_id is required" },
        { status: 400 },
      );
    }

    // Validate and store
    const delay = typeof responseDelaySeconds === "number"
      ? Math.max(0, Math.min(3600, responseDelaySeconds))
      : 0;

    clientDelays.set(client_id, delay);

    return NextResponse.json({
      success: true,
      client_id,
      responseDelaySeconds: delay,
    });
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }
}

/**
 * GET /api/v1/omniflow/portal/bot/whatsapp-response-delay/analytics
 * Returns analytics for admin.
 */
export async function GET_ANALYTICS() {
  const analytics = {
    total_clients: clientDelays.size,
    clients: Array.from(clientDelays.entries()).map(([client_id, delay]) => ({
      client_id,
      responseDelaySeconds: delay,
    })),
    average_delay: clientDelays.size > 0
      ? Math.round(
          Array.from(clientDelays.values()).reduce((a, b) => a + b, 0)
          / clientDelays.size
        )
      : 0,
  };

  return NextResponse.json(analytics);
}