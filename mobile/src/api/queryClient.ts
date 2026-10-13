import { QueryClient } from "@tanstack/react-query";

/**
 * Shared TanStack Query setup. Aggressive-but-sane defaults: dedupe by
 * key, serve cached data instantly while revalidating, bounded retries
 * (the api client already retries transport failures).
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
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
}
