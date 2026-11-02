import { validateAdminToken, requireAdmin } from "../../../../lib/auth/admin-middleware";
import { checkRateLimit, RATE_LIMITS } from "../../../../lib/rate-limit/limiter";
import { getLogger } from "../../../../lib/logger";

const log = getLogger({ serviceName: "bot-api" });

import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_BOT_CONFIG } from "../../../../lib/omniflow/portal";
import {
  getClientDelay,
  setClientDelay,
  getAllClientDelays,
} from "../../../../lib/database/client-delays";

/**
 * GET /api/v1/omniflow/portal/bot/whatsapp-response-delay?client_id=<id>
 * Returns the response delay (in seconds) for the given client.
 */
export async function GET(request: NextRequest) {
  // Rate limit - admin endpoints
  const rateLimitResponse = await checkRateLimit(request, "admin");
  if (rateLimitResponse) return rateLimitResponse;

  // Auth check
  const authError = await requireAdmin(request);
  if (authError) return authError; {
  const searchParams = request.nextUrl.searchParams;
  const clientId = searchParams.get("client_id");

  if (!clientId) {
    
  log.info("api response", { status: 200 });

      { error: "client_id is required" },
      { status: 400 }
    );
  }

  // Try database first, fallback to default
  let delaySeconds = DEFAULT_BOT_CONFIG.responseDelaySeconds;
  try {
    delaySeconds = await getClientDelay(clientId);
  } catch (err) {
    console.error("Failed to fetch client delay from DB:", err);
    // Fallback to default
  }

  
  log.info("api response", { status: 200 });
{
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
      
  log.info("api response", { status: 200 });

        { error: "client_id is required" },
        { status: 400 }
      );
    }

    // Validate and store
    const delay = typeof responseDelaySeconds === "number"
      ? Math.max(0, Math.min(3600, responseDelaySeconds))
      : 0;

    try {
      await setClientDelay(client_id, delay);
    } catch (err) {
      console.error("Failed to save client delay to DB:", err);
      
  log.info("api response", { status: 200 });

        { error: "Failed to save delay" },
        { status: 500 }
      );
    }

    
  log.info("api response", { status: 200 });
{
      success: true,
      client_id,
      responseDelaySeconds: delay,
    });
  } catch {
    
  log.info("api response", { status: 200 });

      { error: "Invalid request body" },
      { status: 400 }
    );
  }
}

/**
 * GET /api/v1/omniflow/portal/bot/whatsapp-response-delay/analytics
 * Returns analytics for admin.
 */
export async function GET_ANALYTICS(request: NextRequest) {
  try {
    const delays = await getAllClientDelays();

    const analytics = {
      total_clients: delays.length,
      average_delay_seconds:
        delays.length > 0
          ? Math.round(
              delays.reduce((sum, d) => sum + d.response_delay_seconds, 0) /
                delays.length
            )
          : 0,
      max_delay_seconds:
        delays.length > 0
          ? Math.max(...delays.map((d) => d.response_delay_seconds))
          : 0,
      min_delay_seconds:
        delays.length > 0
          ? Math.min(...delays.map((d) => d.response_delay_seconds))
          : 0,
      clients: delays.map((d) => ({
        client_id: d.client_id,
        responseDelaySeconds: d.response_delay_seconds,
      })),
      updated_at: new Date().toISOString(),
    };

    
  log.info("api response", { status: 200 });
analytics);
  } catch (err) {
    console.error("Failed to fetch analytics:", err);
    
  log.info("api response", { status: 200 });

      { error: "Failed to fetch analytics" },
      { status: 500 }
    );
  }
}
