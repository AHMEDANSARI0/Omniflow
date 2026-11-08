import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin-middleware";
import { checkRateLimit } from "@/lib/rate-limit/limiter";
import {
  getClientDelay,
  setClientDelay,
} from "@/lib/database/client-delays";
import { getLogger } from "@/lib/logger";

const log = getLogger({ serviceName: "bot-api" });

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, "admin");
  if (rateLimitResponse) return rateLimitResponse;

  const authError = await requireAdmin(request);
  if (authError) return authError;

  const clientId = request.nextUrl.searchParams.get("client_id");
  if (!clientId) {
    return NextResponse.json(
      { error: "client_id is required" },
      { status: 400 }
    );
  }

  try {
    const responseDelaySeconds = await getClientDelay(clientId);
    return NextResponse.json({ client_id: clientId, responseDelaySeconds });
  } catch (error) {
    log.error("Failed to fetch client delay", error, { client_id: clientId });
    return NextResponse.json(
      { error: "Failed to fetch client delay" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, "admin");
  if (rateLimitResponse) return rateLimitResponse;

  const authError = await requireAdmin(request);
  if (authError) return authError;

  let body: { client_id?: unknown; responseDelaySeconds?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }

  const { client_id, responseDelaySeconds } = body;
  if (typeof client_id !== "string" || !client_id.trim()) {
    return NextResponse.json(
      { error: "client_id is required" },
      { status: 400 }
    );
  }

  if (
    responseDelaySeconds !== undefined &&
    (typeof responseDelaySeconds !== "number" ||
      !Number.isFinite(responseDelaySeconds))
  ) {
    return NextResponse.json(
      { error: "responseDelaySeconds must be a number" },
      { status: 400 }
    );
  }

  const delay = Math.max(0, Math.min(3600, responseDelaySeconds ?? 0));
  try {
    await setClientDelay(client_id, delay);
    return NextResponse.json({
      success: true,
      client_id,
      responseDelaySeconds: delay,
    });
  } catch (error) {
    log.error("Failed to save client delay", error, { client_id });
    return NextResponse.json(
      { error: "Failed to save delay" },
      { status: 500 }
    );
  }
}
