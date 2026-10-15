export const ACCESS_COOKIE = "of_access_token";
export const REFRESH_COOKIE = "of_refresh_token";
export const SESSION_COOKIE_NAMES = [ACCESS_COOKIE, REFRESH_COOKIE] as const;

/**
 * §276 — Website marketing-admin session cookie (Neon-backed, replaces the
 * Supabase SSR auth cookies). Kept here (dependency-free) so the Edge proxy
 * can read its presence without importing the Node-only server/auth modules.
 */
export const ADMIN_SESSION_COOKIE = "of_admin_session";

/**
 * §276r4e — true only while `next build` prerenders pages. External services
 * (Neon, Control Plane) must never be contacted during build: an unreachable
 * env host would hang prerender for 60s+ per page. Readers fail soft to code
 * defaults at build time; runtime behaviour is unchanged.
 */
export const IS_PRODUCTION_BUILD = process.env.NEXT_PHASE === "phase-production-build";
