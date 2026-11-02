import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/v1/health
 * Health check endpoint.
 */
export async function GET(request: NextRequest) {
  try {
    // Check if server is running
    const response = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()) + "s",
    };

    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      { status: "unhealthy", error: error instanceof Error ? error.message : "Unknown error" },
      { status: 503 }
    );
  }
}
