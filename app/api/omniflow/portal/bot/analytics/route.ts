import { validateAdminToken, requireAdmin } from "../../../../lib/auth/admin-middleware";
import { checkRateLimit, RATE_LIMITS } from "../../../../lib/rate-limit/limiter";
import { getLogger } from "../../../../lib/logger";

const log = getLogger({ serviceName: "bot-api" });

import { NextRequest, NextResponse } from "next/server";

// Same in-memory store (share with delay route)
import { clientDelays } from "../../bot/whatsapp-response-delay/route";

export async function GET(request: NextRequest) {
  // Rate limit - admin endpoints
  const rateLimitResponse = await checkRateLimit(request, "admin");
  if (rateLimitResponse) return rateLimitResponse;

  // Auth check
  const authError = await requireAdmin(request);
  if (authError) return authError; {
  const analytics = {
    total_clients: clientDelays.size,
    average_delay_seconds: clientDelays.size > 0
      ? Math.round(
          Array.from(clientDelays.values()).reduce((a, b) => a + b, 0)
          / clientDelays.size
        )
      : 0,
    max_delay_seconds: clientDelays.size > 0
      ? Math.max(...Array.from(clientDelays.values()))
      : 0,
    min_delay_seconds: clientDelays.size > 0
      ? Math.min(...Array.from(clientDelays.values()))
      : 0,
    clients: Array.from(clientDelays.entries()).map(([client_id, delay]) => ({
      client_id,
      responseDelaySeconds: delay,
    })),
    updated_at: new Date().toISOString(),
  };

  
  log.info("api response", { status: 200 });
analytics);
}