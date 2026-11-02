import { NextRequest, NextResponse } from "next/server";
import { getLogger } from "../../../../lib/logger";

const log = getLogger({ serviceName: "monitoring" });

/**
 * GET /api/v1/monitoring
 * Get monitoring data (rate limits, errors, etc.).
 */
export async function GET(request: NextRequest) {
  // Auth check - simple token check
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 }
    );
  }

  // Mock monitoring data (in production, fetch from database)
  const monitoringData = {
    uptime: Math.floor(process.uptime()) + "s",
    memory_usage: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100 + "MB",
    cpu_usage: Math.round((process.cpuUsage().user / 1000) * 100) / 100 + "%",
    requests_per_minute: Math.floor(Math.random() * 100) + 50,
    error_rate: Math.floor(Math.random() * 5) / 100 + 0.01,
    active_connections: Math.floor(Math.random() * 50) + 10,
    last_error: null,
    last_updated: new Date().toISOString(),
  };

  log.info("monitoring data fetched", {
    uptime: monitoringData.uptime,
    memory: monitoringData.memory_usage,
  });

  return NextResponse.json(monitoringData);
}

/**
 * POST /api/v1/monitoring/alert
 * Log an alert/notification.
 */
export async function POST(request: NextRequest) {
  // Auth check
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 }
    );
  }

  try {
    const body = await request.json();
    const { level, message, details } = body;

    if (!level || !message) {
      return NextResponse.json(
        { error: "level and message are required" },
        { status: 400 }
      );
    }

    // Log the alert
    if (level === "error") {
      log.error(message, details ? new Error(JSON.stringify(details)) : undefined);
    } else if (level === "warn") {
      log.warn(message, details);
    } else {
      log.info(message, details);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    log.error("Failed to process alert:", error);
    return NextResponse.json(
      { error: "Failed to process alert" },
      { status: 500 }
    );
  }
}
