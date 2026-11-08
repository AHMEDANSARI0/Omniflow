// lib/rate-limit/limiter.ts
// Simple in-memory rate limiter for API endpoints

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

// In-memory store (use Redis in production)
const rateLimitStore = new Map<string, RateLimitEntry>();

// Cleanup interval - runs every minute
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now > entry.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}, 60000);

// Default rate limits per endpoint type
export const RATE_LIMITS = {
  admin: {
    windowMs: 60000,
    maxRequests: 30,
  },
  bot: {
    windowMs: 60000,
    maxRequests: 60,
  },
  general: {
    windowMs: 60000,
    maxRequests: 120,
  },
  whatsapp: {
    windowMs: 60000,
    maxRequests: 300,
  },
};

/**
 * Get client identifier (IP or client_id from request).
 */
function getClientKey(request: Request): string {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id");
  if (clientId) {
    return "client:" + clientId;
  }

  const forwarded = request.headers.get("X-Forwarded-For");
  const ip = forwarded ? forwarded.split(",")[0].trim() : "unknown";
  return "ip:" + ip;
}

/**
 * Check if request is rate limited.
 * Returns null if allowed, or a Response with 429 status.
 */
export async function checkRateLimit(
  request: Request,
  limitType: keyof typeof RATE_LIMITS = "general"
): Promise<Response | null> {
  const config = RATE_LIMITS[limitType];
  const clientId = getClientKey(request);
  const now = Date.now();

  let entry = rateLimitStore.get(clientId);

  if (!entry || now > entry.resetTime) {
    entry = {
      count: 1,
      resetTime: now + config.windowMs,
    };
    rateLimitStore.set(clientId, entry);
    return null;
  }

  entry.count++;

  if (entry.count > config.maxRequests) {
    const retryAfter = Math.ceil((entry.resetTime - now) / 1000);

    return new Response(
      JSON.stringify({
        error: "Rate limit exceeded",
        retry_after_seconds: retryAfter,
        limit_type: limitType,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(config.maxRequests),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(Math.ceil(entry.resetTime / 1000)),
        },
      }
    );
  }

  return null;
}

/**
 * Build rate limit headers for response.
 */
export function addRateLimitHeaders(response: Response, clientKey: string): Response {
  const entry = rateLimitStore.get(clientKey);
  if (!entry) {
    return response;
  }

  const config = RATE_LIMITS.general;
  const remaining = Math.max(0, config.maxRequests - entry.count);
  const resetTime = entry.resetTime;

  const headers = new Headers(response.headers);
  headers.set("X-RateLimit-Limit", String(config.maxRequests));
  headers.set("X-RateLimit-Remaining", String(remaining));
  headers.set("X-RateLimit-Reset", String(Math.ceil(resetTime / 1000)));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
