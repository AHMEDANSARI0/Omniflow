import { cookies } from "next/headers";
import { from } from "@/lib/db/neon";
import { getUserBySession } from "@/lib/db/auth";
import { ADMIN_SESSION_COOKIE } from "@/lib/omniflow/session-constants";

// Re-exported so admin actions / server code have one import site for the
// cookie name (canonical definition lives in session-constants, Edge-safe).
export { ADMIN_SESSION_COOKIE };

/**
 * §276 — Server data client, now backed by NEON (was Supabase SSR).
 *
 * Keeps the SAME surface the ~57 server files already use:
 *   const supabase = await createClient();
 *   const { data: { user } } = await supabase.auth.getUser();
 *   await supabase.from("table").select(...).eq(...);
 * so none of those files change. Auth is a session cookie (httpOnly) whose
 * opaque token is verified against Neon `admin_sessions`. There is no Supabase.
 */

/** The Supabase-shaped user object the website reads (id, email, locked). */
function publicUser(u: { id: string; email: string; role: string } | null) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    locked: false,
    aud: "authenticated",
    app_metadata: { role: u.role },
    user_metadata: {},
  };
}

export async function createClient() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_SESSION_COOKIE)?.value ?? null;

  return {
    from: (table: string) => from(table),
    auth: {
      async getUser() {
        const user = await getUserBySession(token);
        return { data: { user: publicUser(user) }, error: null };
      },
    },
  };
}
