import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useQuery } from "@tanstack/react-query";

import { useDebounce } from "../hooks/useDebounce";
import type { ListPage, ListQuery, Role, SortDirection } from "../../domain/types";
import { invoke } from "../ipc";

const DEFAULT_DEBOUNCE_MS = 100;

export type ListQueryFn<T> = (args: ListQuery) => Promise<T[] | ListPage<T>>;

export interface UseServerListQueryOptions<T> {
  endpoint: string;
  pageSize?: number;
  initialSort?: { field: string; dir: SortDirection } | null;
  initialSearch?: string;
  debounceMs?: number;
  filters?: Record<string, unknown>;
  enabled?: boolean;
  role?: Role;
  /**
   * Optional client-side override. When supplied, this function runs INSTEAD
   * of `domainInvoke(endpoint, args)`. Used by PR-2 skeleton mode so existing
   * client-side filters/sorts keep working until each page migrates to server
   * mode (PR-3+).
   */
  clientFn?: ListQueryFn<T>;
  /** Pass the existing data when clientFn handles pagination itself; set true. */
  clientPaged?: boolean;
}

export interface UseServerListQueryResult<T> {
  rows: T[];
  total: number;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  page: number;
  pageCount: number;
  setPage: Dispatch<SetStateAction<number>>;
  search: string;
  setSearch: Dispatch<SetStateAction<string>>;
  debouncedSearch: string;
  sortField: string | null;
  sortDir: SortDirection | null;
  setSort: (field: string | null, dir: SortDirection | null) => void;
  pageSize: number;
  refetch: () => Promise<unknown>;
}

export function useServerListQuery<T>(opts: UseServerListQueryOptions<T>): UseServerListQueryResult<T> {
  const {
    endpoint,
    pageSize = 25,
    initialSort = null,
    initialSearch = "",
    debounceMs = DEFAULT_DEBOUNCE_MS,
    filters,
    enabled = true,
    role,
    clientFn,
    clientPaged = false,
  } = opts;

  const [page, setPageState] = useState(1);
  const [searchState, setSearchState] = useState(initialSearch);
  const [sortField, setSortField] = useState<string | null>(initialSort?.field ?? null);
  const [sortDir, setSortDir] = useState<SortDirection | null>(initialSort?.dir ?? null);

  const debouncedSearch = useDebounce(searchState, debounceMs).trim();

  const setPage = useCallback<Dispatch<SetStateAction<number>>>((next) => {
    setPageState((current) => {
      const resolved = typeof next === "function" ? (next as (p: number) => number)(current) : next;
      return Math.max(1, resolved);
    });
  }, []);

  const setSearch = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    setSearchState((current) => {
      const resolved = typeof next === "function" ? (next as (s: string) => string)(current) : next;
      if (resolved !== current) setPageState(1);
      return resolved;
    });
  }, []);

  const setSort = useCallback((field: string | null, dir: SortDirection | null) => {
    setSortField(field);
    setSortDir(dir);
    setPageState(1);
  }, []);

  const queryKey = useMemo(
    () => ["list", endpoint, { search: debouncedSearch, sortField, sortDir, page, pageSize, filters, role, clientPaged }] as const,
    [endpoint, debouncedSearch, sortField, sortDir, page, pageSize, filters, role, clientPaged],
  );

  const args = useMemo<ListQuery>(() => {
    const offset = (page - 1) * pageSize;
    const a: ListQuery = {
      limit: pageSize,
      offset,
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      ...(sortField && sortDir ? { sort_field: sortField, sort_dir: sortDir } : {}),
      ...(filters ? { filters } : {}),
    };
    return a;
  }, [debouncedSearch, sortField, sortDir, page, pageSize, filters]);

  const query = useQuery<ListPage<T>, Error>({
    queryKey,
    enabled,
    queryFn: async (): Promise<ListPage<T>> => {
      if (clientFn) {
        const raw = await clientFn(args);
        if (Array.isArray(raw)) {
          const start = (args.offset ?? 0);
          const end = start + (args.limit ?? raw.length);
          return { rows: raw.slice(start, end), total: raw.length };
        }
        return raw;
      }
      return invoke<ListPage<T>>(endpoint, args as unknown as Record<string, unknown>);
    },
  });

  const total = query.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    if (page > pageCount) setPageState(pageCount);
  }, [page, pageCount]);

  return {
    rows: query.data?.rows ?? [],
    total,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    page,
    pageCount,
    setPage,
    search: searchState,
    setSearch,
    debouncedSearch,
    sortField,
    sortDir,
    setSort,
    pageSize,
    refetch: query.refetch,
  };
}