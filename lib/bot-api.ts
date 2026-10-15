/**
 * §276 — DEPRECATED / inert. Authenticated the legacy website-hosted bot's API
 * keys (`Authorization: Bearer ofk_...`) against a Supabase `api_keys` table
 * that no longer exists. Bot authentication now lives in the OmniFlow Control
 * Plane. The function is kept so any lingering import still compiles, but it
 * always returns null (unauthenticated) and touches no database.
 */
export async function authenticateApiKey(
  _request: Request
): Promise<string | null> {
  return null;
}
