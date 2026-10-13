import { from } from "@/lib/db/neon";

/**
 * §276 — Server-only "service" client, now backed by NEON (was Supabase
 * service-role). Full access (no cookie/RLS); used by server routes/actions
 * that scope access manually. Keeps the same `.from(table)` surface.
 *
 * Supabase's `auth.admin.createUser` has no Neon equivalent here: website
 * admin accounts are created by the migration/bootstrap tooling, and client
 * portal accounts are created by the Control Plane. It is intentionally a
 * disabled stub so any leftover caller fails loudly instead of silently.
 * NEVER import this in client components.
 */
export function createServiceClient() {
  return {
    from: (table: string) => from(table),
    auth: {
      admin: {
        async createUser() {
          throw new Error(
            "auth.admin.createUser is not available on Neon. Create website admins via the migration/bootstrap tool, and portal clients via the Control Plane."
          );
        },
      },
    },
  };
}
