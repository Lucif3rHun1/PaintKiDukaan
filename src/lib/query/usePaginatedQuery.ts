// @ts-nocheck
import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useQuery, type QueryKey } from "@tanstack/react-query";

import { useDebounce } from "../hooks/useDebounce";

export interface PaginatedRows<TItem> {
  rows: TItem[];
  total_paise: number;
}

type QueryRows<TItem> = TItem[] | PaginatedRows<TItem>;

interface QueryContext {
  search: string;
  page: number;
  pageSize: number;
}

export interface UsePaginatedQueryOptions<TItem> {
  queryKey: QueryKey;
  queryFn: (context: QueryContext) => Promise<QueryRows<TItem>>;
  pageSize?: number;
  initialSearch?: string;
  debounceMs?: number;
  enabled?: boolean;
  clientFilter?: (item: TItem, search: string) => boolean;
  clientSort?: (a: TItem, b: TItem) => number;
}

export interface UsePaginatedQueryResult<TItem> {
  data: TItem[];
  allData: TItem[];
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
  refetch: () => void;
}

function normalizeRows<TItem>(result: QueryRows<TItem>): PaginatedRows<TItem> | null {
  if (Array.isArray(result)) return { rows: result, total: result.length };
  return result;
}

export function usePaginatedQuery<TItem>({
  queryKey,
  queryFn,
  pageSize = 25,
  initialSearch = "",
  debounceMs = 250,
  enabled = true,
  clientFilter,
  clientSort,
}: UsePaginatedQueryOptions<TItem>): UsePaginatedQueryResult<TItem> {
  const [page, setPageState] = useState(1);
  const [searchState, setSearchState] = useState(initialSearch);
  const debouncedSearch = useDebounce(searchState, debounceMs).trim();

  const setPage = useCallback<Dispatch<SetStateAction<number>>>((nextPage) => {
    setPageState((current) => Math.max(1, typeof nextPage === "function" ? nextPage(current) : nextPage));
  }, []);

  const setSearch = useCallback<Dispatch<SetStateAction<string>>>((nextSearch) => {
    setSearchState((current) => {
      const resolved = typeof nextSearch === "function" ? nextSearch(current) : nextSearch;
      if (resolved !== current) setPageState(1);
      return resolved;
    });
  }, []);

  const normalizedKey = useMemo(
    () => [...queryKey, { search: debouncedSearch, page, pageSize }] as const,
    [debouncedSearch, page, pageSize, queryKey],
  );

  const query = useQuery({
    queryKey: normalizedKey,
    enabled,
    queryFn: async () => normalizeRows(await queryFn({ search: debouncedSearch, page, pageSize })),
    placeholderData: (previous) => previous,
  });

  const preparedRows = useMemo(() => {
    const rows = [...(query.data?.rows ?? [])];
    const filtered = clientFilter
      ? rows.filter((item) => clientFilter(item, debouncedSearch))
      : rows;
    return clientSort ? [...filtered].sort(clientSort) : filtered;
  }, [clientFilter, clientSort, debouncedSearch, query.data?.rows]);

  const totalItems = query.data && query.data.total !== query.data.rows.length
    ? query.data.total
    : preparedRows.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

  useEffect(() => {
    if (page > totalPages) setPageState(totalPages);
  }, [page, totalPages]);

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
    refetch: () => void query.refetch(),
  };
}
