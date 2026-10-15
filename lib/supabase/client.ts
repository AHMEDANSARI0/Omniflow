/**
 * §276 — DEPRECATED / intentionally inert.
 *
 * This used to create a browser Supabase client for admin auth. Supabase is
 * gone: website admin auth now runs through SERVER ACTIONS (see
 * `lib/admin-actions.ts`) over a Neon-backed httpOnly session cookie, so the
 * browser never talks to the database directly and needs no client SDK.
 *
 * Nothing imports this anymore. It is kept as an empty module (rather than
 * deleted) so the patcher can overwrite it safely; it will be removed in a
 * later cleanup. Do NOT add a Supabase client here.
 */
export {};
