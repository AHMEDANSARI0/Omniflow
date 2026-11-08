import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin-middleware";
import { checkRateLimit } from "@/lib/rate-limit/limiter";
import { getAllClientDelays } from "@/lib/database/client-delays";
import { getLogger } from "@/lib/logger";

const log = getLogger({ serviceName: "bot-api" });

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, "admin");
  if (rateLimitResponse) return rateLimitResponse;

  const authError = await requireAdmin(request);
  if (authError) return authError;

  try {
    const delays = await getAllClientDelays();
    const values = delays.map((delay) => delay.response_delay_seconds);
    const analytics = {
      total_clients: delays.length,
      average_delay_seconds: values.length
        ? Math.round(values.reduce((sum, delay) => sum + delay, 0) / values.length)
        : 0,
      max_delay_seconds: values.length ? Math.max(...values) : 0,
      min_delay_seconds: values.length ? Math.min(...values) : 0,
      clients: delays.map((delay) => ({
        client_id: delay.client_id,
        responseDelaySeconds: delay.response_delay_seconds,
      })),
      updated_at: new Date().toISOString(),
    };

    log.info("bot delay analytics fetched", { total_clients: delays.length });
    return NextResponse.json(analytics);
  } catch (error) {
    log.error("Failed to fetch bot delay analytics", error);
    return NextResponse.json(
      { error: "Failed to fetch analytics" },
      { status: 500 }
    );
  }
}