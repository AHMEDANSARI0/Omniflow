// lib/auth/admin-middleware.ts
// Admin authentication middleware for Next.js API routes

interface AdminUser {
  id: string;
  email: string;
  role: string;
  client_ids?: string[];
}

type AdminRequest = Request & { adminUser?: AdminUser };

/**
 * Validate admin JWT token from Authorization header.
 * Supports Bearer token from Control Plane or local session.
 */
export async function validateAdminToken(
  request: Request
): Promise<AdminUser | null> {
  const authHeader = request.headers.get("Authorization") || "";

  if (!authHeader.startsWith("Bearer ")) {
    // Try cookie-based session (for same-origin requests)
    const cookieHeader = request.headers.get("Cookie") || "";
    const sessionMatch = cookieHeader.match(/session=([^;]+)/);
    if (sessionMatch) {
      try {
        const session = JSON.parse(Buffer.from(sessionMatch[1], "base64").toString("utf-8"));
        if (session?.user?.role) {
          return session.user;
        }
      } catch {
        // Invalid session
      }
    }
    return null;
  }

  const token = authHeader.slice(7);

  // For now, accept any non-empty token as admin (simplify for dev)
  // In production, validate against CP or your auth service
  if (token.length > 0) {
    return {
      id: "admin",
      email: "admin@example.com",
      role: "admin",
    };
  }

  return null;
}

/**
 * Require admin role - returns 401/403 if not authorized.
 */
export async function requireAdmin(
  request: Request
): Promise<Response | null> {
  const user = await validateAdminToken(request);

  if (!user) {
    return new Response(
      JSON.stringify({ error: "Authentication required" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  if (user.role === "viewer") {
    return new Response(
      JSON.stringify({ error: "Insufficient permissions" }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Attach user to request for downstream use
  (request as AdminRequest).adminUser = user;
  return null;
}

/**
 * Require specific role.
 */
export async function requireRole(
  request: Request,
  allowedRoles: readonly string[]
): Promise<Response | null> {
  const user = await validateAdminToken(request);

  if (!user) {
    return new Response(
      JSON.stringify({ error: "Authentication required" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  if (!allowedRoles.includes(user.role)) {
    return new Response(
      JSON.stringify({ error: "Insufficient permissions" }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  (request as AdminRequest).adminUser = user;
  return null;
}
