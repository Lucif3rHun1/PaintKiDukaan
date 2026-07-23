import { QueryClient, QueryCache, MutationCache } from "@tanstack/react-query";
import { toast } from "../feedback/toast";
import { extractError } from "../extractError";

// ponytail: check code field from Rust AppError serialization (error.rs line 106-115)
function isAuthError(e: unknown): boolean {
  if (e && typeof e === "object") {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") {
      return code === "not_unlocked" || code === "unauthorized" || code === "forbidden";
    }
  }
  return false;
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      // Suppress toast for expected pre-login ACL denials (not_unlocked, unauthorized).
      // These fire during boot before the security phase resolves — not real errors.
      if (isAuthError(error)) return;
      // Pages with explicit error= handlers suppress global toast via meta flag.
      if (!(query.meta as { suppressGlobalErrorToast?: boolean } | undefined)?.suppressGlobalErrorToast) {
        toast.error(extractError(error));
      }
    },
  }),
  mutationCache: new MutationCache({
    onError: (error) => {
      if (isAuthError(error)) return;
      toast.error(extractError(error));
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      // ponytail: skip retry on auth errors (not_unlocked, unauthorized, forbidden)
      retry: (_count, error) => !isAuthError(error),
      refetchOnWindowFocus: false,
      structuralSharing: true,
    },
    mutations: {
      retry: 0,
    },
  },
});

// Dev-only: warn when invalidateQueries matches zero active queries.
// Catches dead-key invalidations like ["items"], ["customers"], ["sales-list"]
// (see audit-4 Section C / Appendix in .omo/notepads/arch-audit-2026-07-23/).
// The ["dashboard"] umbrella is excluded by definition (matches ~20 dashboard
// queries by design). Skipped in production builds via import.meta.env.DEV.
if (import.meta.env.DEV) {
  const original = queryClient.invalidateQueries.bind(queryClient);
  // ponytail: dev-only zero-match detector; type erasure is acceptable for
  // an internal monkey-patch in a DEV-only branch.
  queryClient.invalidateQueries = function (
    this: QueryClient,
    ...args: Parameters<QueryClient["invalidateQueries"]>
  ): ReturnType<QueryClient["invalidateQueries"]> {
    const filters = args[0] as { queryKey?: unknown } | undefined;
    const key = filters?.queryKey;
    const result = original(...args);
    if (Array.isArray(key)) {
      void Promise.resolve(result).then(() => {
        const queries = queryClient.getQueryCache().getAll();
        const matches = queries.some((q) => {
          const qk = q.queryKey;
          if (qk.length < key.length) return false;
          return key.every((segment, i) => qk[i] === segment);
        });
        if (!matches) {
          // eslint-disable-next-line no-console -- intentional dev-only signal
          console.warn(
            `[queryClient] invalidateQueries(${JSON.stringify(key)}) matched 0 active queries. ` +
              `Likely dead-key bug. Use invalidateList(qc, endpoint) or invalidateListMetrics(qc, endpoint) ` +
              `from src/lib/query/invalidateList.ts for list/metrics invalidations. ` +
              `See .omo/notepads/arch-audit-2026-07-23/audit-4-invalidation-graph.md.`,
          );
        }
      });
    }
    return result;
  } as QueryClient["invalidateQueries"];
}
