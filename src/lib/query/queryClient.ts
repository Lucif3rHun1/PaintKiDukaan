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
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});
