import { QueryClient } from "@tanstack/react-query";

let client: QueryClient | null = null;

/** Shared TanStack Query setup. Aggressive-but-sane defaults: dedupe by
 * key, serve cached data instantly while revalidating, bounded retries
 * (the api client already retries transport failures).
 */
export function createQueryClient(): QueryClient {
  client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: 0 },
    },
  });
  return client;
}

/** Clear every query in the shared client — used on logout / account
 * switch so the next session never sees the previous one's cached data. */
export function clearQueryCache(): void {
  client?.clear();
}