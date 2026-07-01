import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useQuery } from "@tanstack/react-query";

import type { ListPage } from "../../domain/types";
import { useDebounce } from "../hooks/useDebounce";

export interface ClientListContext {
  search: string;
  page: number;
  pageSize: number;
}

export type ClientListFn<T> = (ctx: ClientListContext) => Promise<T[] | ListPage<T>>;

export interface UseClientListQueryOptions<T> {
  queryKey: readonly unknown[];
  queryFn: ClientListFn<T>;
  pageSize?: number;
  initialSearch?: string;
  debounceMs?: number;
  enabled?: boolean;
  clientFilter?: (item: T, search: string) => boolean;
  clientSort?: (a: T, b: T) => number;
}

export interface UseClientListQueryResult<T> {
  data: T[];
  allData: T[];
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  page: number;
  setPage: Dispatch<SetStateAction<number>>;
  search: string;
  debouncedSearch: string;
  setSearch: Dispatch<SetStateAction<string>>;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  refetch: () => Promise<unknown>;
}

function normalize<T>(result: T[] | ListPage<T>): ListPage<T> | null {
  if (Array.isArray(result)) return { rows: result, total: result.length };
  return result;
}

export function useClientListQuery<T>(opts: UseClientListQueryOptions<T>): UseClientListQueryResult<T> {
  const {
    queryKey,
    queryFn,
    pageSize = 25,
    initialSearch = "",
    debounceMs = 100,
    enabled = true,
    clientFilter,
    clientSort,
  } = opts;

  const [page, setPageState] = useState(1);
  const [searchState, setSearchState] = useState(initialSearch);
  const debouncedSearch = useDebounce(searchState, debounceMs).trim();

  const setPage = useCallback<Dispatch<SetStateAction<number>>>((next) => {
    setPageState((current) =>
      Math.max(1, typeof next === "function" ? (next as (p: number) => number)(current) : next),
    );
  }, []);

  const setSearch = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    setSearchState((current) => {
      const resolved = typeof next === "function" ? (next as (s: string) => string)(current) : next;
      if (resolved !== current) setPageState(1);
      return resolved;
    });
  }, []);

  const normalizedKey = useMemo(
    () => [...queryKey, { search: debouncedSearch, page, pageSize }] as const,
    [debouncedSearch, page, pageSize, queryKey],
  );

  const query = useQuery<ListPage<T>, Error>({
    queryKey: normalizedKey,
    enabled,
    queryFn: async () => normalize(await queryFn({ search: debouncedSearch, page, pageSize })) ?? { rows: [], total: 0 },
  });

  const preparedRows = useMemo(() => {
    const rows = [...(query.data?.rows ?? [])];
    const filtered = clientFilter ? rows.filter((it) => clientFilter(it, debouncedSearch)) : rows;
    return clientSort ? [...filtered].sort(clientSort) : filtered;
  }, [clientFilter, clientSort, debouncedSearch, query.data?.rows]);

  const totalItems = query.data && query.data.total !== query.data.rows.length
    ? query.data.total
    : preparedRows.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

  const pageRows = useMemo(() => {
    if (query.data && query.data.total !== query.data.rows.length) return preparedRows;
    const start = (page - 1) * pageSize;
    return preparedRows.slice(start, start + pageSize);
  }, [page, pageSize, preparedRows, query.data]);

  return {
    data: pageRows,
    allData: preparedRows,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    page,
    setPage,
    search: searchState,
    debouncedSearch,
    setSearch,
    pageSize,
    totalItems,
    totalPages,
    refetch: query.refetch,
  };
}