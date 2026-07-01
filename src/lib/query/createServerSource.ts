import { useMemo } from "react";
import type { ListPage, ListQuery, SortDirection } from "../../domain/types";
import { invoke } from "../../domain/ipc";
import { useServerListQuery, type UseServerListQueryResult } from "./useServerListQuery";

export interface ServerSourceOptions<T> {
  endpoint: string;
  pageSize?: number;
  initialSort?: { field: string; dir: SortDirection } | null;
  initialSearch?: string;
  debounceMs?: number;
  filters?: Record<string, unknown>;
  enabled?: boolean;
}

export type ServerSourceResult<T> = UseServerListQueryResult<T>;

export function createServerSource<T>(opts: ServerSourceOptions<T>): ServerSourceResult<T> {
  return useServerListQuery<T>(opts);
}

export function buildListArgs<TFilters extends Record<string, unknown>>(
  base: { limit: number; offset: number; search?: string },
  filters?: TFilters,
): ListQuery {
  return {
    ...base,
    ...(filters ? { filters: filters as unknown as Record<string, unknown> } : {}),
  };
}

export function useServerListArgs(
  endpoint: string,
  search: string,
  sortField: string | null,
  sortDir: SortDirection | null,
  page: number,
  pageSize: number,
  filters?: Record<string, unknown>,
): ListQuery {
  return useMemo(() => buildListArgs(
    {
      limit: pageSize,
      offset: (page - 1) * pageSize,
      ...(search ? { search } : {}),
      ...(sortField && sortDir ? { sort_field: sortField, sort_dir: sortDir } : {}),
    },
    filters,
  ), [search, sortField, sortDir, page, pageSize, filters]);
}

export type { ListPage };
export { invoke };