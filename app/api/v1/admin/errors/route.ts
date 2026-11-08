import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin-middleware";
import { getLogger } from "@/lib/logger";

const log = getLogger({ serviceName: "error-tracker" });

/**
 * GET /api/v1/admin/errors
 * Get recent errors (admin only).
 */
export async function GET(request: NextRequest) {
  // Auth check
  const authError = await requireAdmin(request);
  if (authError) return authError;

  const searchParams = request.nextUrl.searchParams;
  const limit = parseInt(searchParams.get("limit") || "10");
  const offset = parseInt(searchParams.get("offset") || "0");

  // Mock error data (in production, fetch from database)
  const errors = [];
  for (let i = 0; i < limit; i++) {
    errors.push({
      id: `err-${(offset + i) * 100}`,
      timestamp: new Date(Date.now() - Math.random() * 24 * 60 * 60 * 1000).toISOString(),
      level: Math.random() > 0.7 ? "error" : "warn",
      message: "Sample error message " + (i + 1),
      source: "bot-api",
      client_id: Math.random() > 0.5 ? "1" : "4",
      details: {
        request_id: `req-${(offset + i) * 100}`,
        user_agent: "Mozilla/5.0",
        ip: "192.168.1.1",
      },
    });
  }

  log.info("errors fetched", { count: errors.length, limit, offset });

  return NextResponse.json({
    errors,
    total: errors.length,
    limit,
    offset,
  });
}

/**
 * POST /api/v1/admin/errors/clear
 * Clear error logs (admin only).
 */
export async function POST(request: NextRequest) {
  // Auth check
  const authError = await requireAdmin(request);
  if (authError) return authError;

  try {
    // In production, clear errors from database
    log.info("errors cleared by admin");

    return NextResponse.json({ success: true });
  } catch (error) {
    log.error("Failed to clear errors:", error);
    return NextResponse.json(
      { error: "Failed to clear errors" },
      { status: 500 }
    );
  }
}
