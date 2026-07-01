import * as React from "react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronUp, X } from "lucide-react";

import { cn } from "./cn";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import { Alert } from "./Alert";
import { SkeletonRow } from "./SkeletonRow";
import { SearchInput } from "./SearchInput";
import { PaginationControls } from "./PaginationControls";
import type { Role, SortDirection } from "../../domain/types";
import { useServerListQuery } from "../../lib/query/useServerListQuery";

export type { SortDirection } from "../../domain/types";

export type DataListRole = Role;

export interface ColumnDef<T> {
  id?: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  className?: string;
  width?: string;
  align?: "left" | "right" | "center";
  sortable?: boolean;
  sortField?: string;
  searchable?: boolean;
  visible?: (ctx: { row?: T; role?: DataListRole }) => boolean;
  checkbox?: boolean;
}

export interface GroupAccessor<T> {
  key: (row: T) => string;
  label: (key: string) => ReactNode;
  level?: 1 | 2;
}

export interface DataListSelection<T> {
  selected: Set<string | number>;
  onChange: (next: Set<string | number>) => void;
  keyOf: (row: T) => string | number;
  selectAllMode?: "page" | "filtered";
}

export interface DataListServerSource<T> {
  endpoint: string;
  pageSize?: number;
  initialSort?: { field: string; dir: SortDirection } | null;
  initialSearch?: string;
  debounceMs?: number;
  filters?: Record<string, unknown>;
  enabled?: boolean;
  role?: DataListRole;
  clientFn?: (args: import("../../domain/types").ListQuery) => Promise<T[] | import("../../domain/types").ListPage<T>>;
  clientPaged?: boolean;
}

export interface DataListClientSource<T> {
  data: T[];
  loading?: boolean;
  error?: Error | null;
  search?: string;
  onSearchChange?: (next: string) => void;
  page?: number;
  pageSize?: number;
  totalItems?: number;
  totalPages?: number;
  onPageChange?: (next: number) => void;
  sortField?: string | null;
  sortDir?: SortDirection | null;
  onSortChange?: (field: string | null, dir: SortDirection | null) => void;
  refetch?: () => void;
}

export type DataListSource<T> = DataListServerSource<T> | DataListClientSource<T>;

export interface DataListProps<T> {
  source: DataListSource<T>;
  columns: ColumnDef<T>[];
  keyExtractor: (row: T, index: number) => string | number;
  searchPlaceholder?: string;
  pageSize?: number;
  onRowClick?: (row: T, index: number) => void;
  onRowDoubleClick?: (row: T, index: number) => void;
  groupBy?: GroupAccessor<T>[];
  selection?: DataListSelection<T>;
  headerMetrics?: ReactNode;
  headerActions?: ReactNode;
  toolbar?: ReactNode;
  actions?: ReactNode;
  rowActions?: (row: T, index: number) => ReactNode;
  onExport?: (rows: T[]) => void;
  emptyState?: (ctx: { total: number; hasActiveFilter: boolean }) => ReactNode;
  errorState?: (error: Error) => ReactNode;
  footer?: ReactNode;
  className?: string;
  rowClassName?: string | ((row: T, index: number) => string);
  caption?: string;
  height?: number | string;
  estimateRowHeight?: number;
  emptyMessage?: string;
  emptyCta?: ReactNode;
  role?: DataListRole;
  testId?: string;
}

interface FlattenedVirtualRow<T> {
  kind: "row" | "group";
  rowIndex?: number;
  level?: 1 | 2;
  groupKey?: string;
  groupAccessorIndex?: number;
  row?: T;
}

function flattenRows<T>(
  rows: T[],
  groupBy: GroupAccessor<T>[] | undefined,
): FlattenedVirtualRow<T>[] {
  if (!groupBy || groupBy.length === 0) {
    return rows.map((row, idx): FlattenedVirtualRow<T> => ({ kind: "row", rowIndex: idx, row }));
  }
  const items: FlattenedVirtualRow<T>[] = [];
  let currentComposite = "__none__";
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const keys = groupBy.map((g) => g.key(row));
    const composite = keys.join("\u0001");
    if (composite !== currentComposite) {
      currentComposite = composite;
      for (let g = 0; g < groupBy.length; g++) {
        items.push({
          kind: "group",
          level: (groupBy[g].level ?? 1) as 1 | 2,
          groupKey: keys[g],
          groupAccessorIndex: g,
        });
      }
    }
    items.push({ kind: "row", rowIndex: i, row });
  }
  return items;
}

function alignClass(align?: "left" | "right" | "center"): string {
  if (align === "right") return "text-right";
  if (align === "center") return "text-center";
  return "text-left";
}

interface InternalSource<T> {
  rows: T[];
  total: number;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  search: string;
  setSearch: (v: string) => void;
  page: number;
  setPage: (p: number) => void;
  pageCount: number;
  pageSize: number;
  sortField: string | null;
  sortDir: SortDirection | null;
  setSort: (f: string | null, d: SortDirection | null) => void;
}

function isServerSource<T>(s: DataListSource<T>): s is DataListServerSource<T> {
  return "endpoint" in s && !("data" in s);
}

export function DataList<T>(props: DataListProps<T>): React.ReactElement {
  const src = props.source;
  if ("data" in src) {
    return <ClientDataList<T> {...props} source={src as DataListClientSource<T>} />;
  }
  return <ServerDataList<T> {...props} source={src as DataListServerSource<T>} />;
}

function ServerDataList<T>(props: Omit<DataListProps<T>, "source"> & { source: DataListServerSource<T> }): React.ReactElement {
  const { source } = props;
  const result = useServerListQuery<T>({
    endpoint: source.endpoint,
    pageSize: source.pageSize ?? props.pageSize ?? 25,
    initialSort: source.initialSort,
    initialSearch: source.initialSearch,
    debounceMs: source.debounceMs,
    filters: source.filters,
    enabled: source.enabled,
    role: source.role,
    clientFn: source.clientFn,
    clientPaged: source.clientPaged,
  });
  return <DataListInner<T> {...props} source={result} />;
}

function ClientDataList<T>(props: Omit<DataListProps<T>, "source"> & { source: DataListClientSource<T> }): React.ReactElement {
  const { source } = props;
  const result: InternalSource<T> = useMemo(() => ({
    rows: source.data ?? [],
    total: source.totalItems ?? (source.data?.length ?? 0),
    isLoading: source.loading ?? false,
    isFetching: false,
    error: source.error ?? null,
    search: source.search ?? "",
    setSearch: source.onSearchChange ?? (() => undefined),
    page: source.page ?? 1,
    setPage: source.onPageChange ?? (() => undefined),
    pageCount: source.totalPages ?? 1,
    pageSize: source.pageSize ?? props.pageSize ?? 25,
    sortField: source.sortField ?? null,
    sortDir: source.sortDir ?? null,
    setSort: source.onSortChange ?? (() => undefined),
  }), [
    source.data, source.loading, source.error, source.search, source.onSearchChange,
    source.page, source.onPageChange, source.totalPages, source.totalItems, source.pageSize,
    source.sortField, source.sortDir, source.onSortChange, props.pageSize,
  ]);
  return <DataListInner<T> {...props} source={result} />;
}

function DataListInner<T>(props: Omit<DataListProps<T>, "source"> & { source: InternalSource<T> }): React.ReactElement {
  const {
    columns,
    keyExtractor,
    searchPlaceholder,
    onRowClick,
    onRowDoubleClick,
    groupBy,
    selection,
    headerMetrics,
    headerActions,
    toolbar,
    actions,
    rowActions,
    onExport,
    emptyState,
    errorState,
    footer,
    className,
    rowClassName,
    caption,
    height = 480,
    estimateRowHeight = 36,
    emptyMessage = "No data",
    emptyCta,
    role,
    testId,
  } = props;

  const {
    rows,
    total,
    isLoading,
    isFetching,
    error,
    search,
    setSearch,
    page,
    pageCount,
    pageSize,
    setPage,
    sortField,
    sortDir,
    setSort,
  } = props.source;

  const visibleColumns = useMemo(
    () => columns.filter((col) => !col.visible || col.visible({ role })),
    [columns, role],
  );

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  const flatItems = useMemo(() => flattenRows(rows, groupBy), [rows, groupBy]);
  const dataRowIndices = useMemo(
    () => flatItems.filter((i) => i.kind === "row").map((i) => i.rowIndex ?? 0),
    [flatItems],
  );

  const rowVirtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: (i) => {
      const it = flatItems[i];
      return it?.kind === "group" ? 28 : estimateRowHeight;
    },
    overscan: 6,
  });

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (dataRowIndices.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((cur) => {
          if (cur === null) return dataRowIndices[0];
          const pos = dataRowIndices.indexOf(cur);
          return dataRowIndices[Math.min(dataRowIndices.length - 1, pos + 1)] ?? cur;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((cur) => {
          if (cur === null) return dataRowIndices[0];
          const pos = dataRowIndices.indexOf(cur);
          return dataRowIndices[Math.max(0, pos - 1)] ?? cur;
        });
      } else if (e.key === "Enter" && focusedIndex !== null && onRowClick) {
        const row = rows[focusedIndex];
        if (row) {
          e.preventDefault();
          onRowClick(row, focusedIndex);
        }
      } else if (e.key === "Escape" && search) {
        e.preventDefault();
        setSearch("");
      }
    },
    [dataRowIndices, focusedIndex, onRowClick, rows, search, setSearch],
  );

  useEffect(() => {
    if (focusedIndex !== null) {
      rowVirtualizer.scrollToIndex(focusedIndex, { align: "auto" });
    }
  }, [focusedIndex, rowVirtualizer]);

  const hasActiveFilter = (search?.trim() ?? "") !== "";

  const checkboxColumn: ColumnDef<T> | null = selection
    ? {
        id: "__select",
        header: (
          <input
            type="checkbox"
            aria-label={(() => {
              const allSelected =
                rows.length > 0 && rows.every((r) => selection.selected.has(selection.keyOf(r)));
              return allSelected ? "Deselect all rows" : "Select all rows";
            })()}
            checked={
              rows.length > 0 && rows.every((r) => selection.selected.has(selection.keyOf(r)))
            }
            onChange={(e) => {
              const next = new Set(selection.selected);
              if (e.target.checked) rows.forEach((r) => next.add(selection.keyOf(r)));
              else rows.forEach((r) => next.delete(selection.keyOf(r)));
              selection.onChange(next);
            }}
            className="h-4 w-4 cursor-pointer"
          />
        ),
        cell: (row) => (
          <input
            type="checkbox"
            aria-label="Select row"
            checked={selection.selected.has(selection.keyOf(row))}
            onChange={(e) => {
              const next = new Set(selection.selected);
              if (e.target.checked) next.add(selection.keyOf(row));
              else next.delete(selection.keyOf(row));
              selection.onChange(next);
            }}
            onClick={(e) => e.stopPropagation()}
            className="h-4 w-4 cursor-pointer"
          />
        ),
        width: "32px",
        align: "center",
      }
    : null;

  const finalColumns: ColumnDef<T>[] = checkboxColumn ? [checkboxColumn, ...visibleColumns] : visibleColumns;

  if (error && errorState) {
    return <div className={className}>{errorState(error)}</div>;
  }

  return (
    <div className={cn("flex flex-col gap-3", className)} data-testid={testId}>
      {headerMetrics ? <div className="flex flex-wrap gap-3">{headerMetrics}</div> : null}
      {(toolbar || actions) ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">{toolbar}</div>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-[260px] flex-1 items-center gap-2">
          <SearchInput
            value={search}
            onChange={(v) => setSearch(v)}
            placeholder={searchPlaceholder ?? "Search…"}
            debounceMs={100}
            data-shortcut="search"
          />
        </div>
        <div className="flex items-center gap-2">
          {headerActions}
          {onExport ? (
            <Button type="button" size="sm" variant="secondary" onClick={() => onExport(rows)} disabled={rows.length === 0}>
              Export
            </Button>
          ) : null}
          {pageCount > 1 ? (
            <PaginationControls
              page={page}
              totalPages={pageCount}
              totalItems={total}
              pageSize={pageSize}
              onPageChange={(p) => setPage(p)}
            />
          ) : null}
        </div>
      </div>
      {error ? (
        <Alert variant="destructive" title="Failed to load data">
          {error.message}
        </Alert>
      ) : null}
      <div
        ref={scrollerRef}
        role="grid"
        aria-rowcount={rows.length}
        aria-label={caption ?? "Data list"}
        onKeyDown={onKeyDown}
        className="relative overflow-auto rounded border border-border bg-card"
        style={{ height: typeof height === "number" ? `${height}px` : height }}
      >
        {caption ? <div className="sr-only">{caption}</div> : null}
        <div className="sticky top-0 z-10 flex border-b border-border bg-card text-left text-xs uppercase text-muted-foreground" role="row">
          {finalColumns.map((col, colIdx) => (
            <div
              key={col.id ?? (typeof col.header === "string" ? col.header : undefined) ?? `col-${colIdx}`}
              role="columnheader"
              style={col.width ? { width: col.width, minWidth: col.width } : undefined}
              className={cn("flex items-center px-3 py-2 font-medium", alignClass(col.align), col.className)}
              onClick={
                col.sortable && col.sortField
                  ? () => {
                      if (sortField !== col.sortField) {
                        setSort(col.sortField!, "asc");
                      } else if (sortDir === "asc") {
                        setSort(col.sortField!, "desc");
                      } else {
                        setSort(null, null);
                      }
                    }
                  : undefined
              }
            >
              <span className={cn("inline-flex items-center gap-1", col.sortable && "cursor-pointer select-none")}>
                {col.header}
                {col.sortable && col.sortField === sortField ? (
                  sortDir === "asc" ? (
                    <ChevronUp className="h-3 w-3" />
                  ) : sortDir === "desc" ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <X className="h-3 w-3 opacity-30" />
                  )
                ) : null}
              </span>
            </div>
          ))}
          {rowActions ? <div role="columnheader" className="ml-auto w-12 px-3 py-2" aria-label="Actions" /> : null}
        </div>
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
          {isLoading ? (
            <div className="p-3">
              <SkeletonRow count={8} />
            </div>
          ) : rows.length === 0 ? (
            <div className="p-3">
              {emptyState ? (
                emptyState({ total, hasActiveFilter })
              ) : (
                <EmptyState
                  title={hasActiveFilter ? "No matches" : emptyMessage}
                  description={hasActiveFilter ? "Try clearing your search or filters." : undefined}
                  primary={emptyCta}
                />
              )}
            </div>
          ) : (
            rowVirtualizer.getVirtualItems().map((vRow) => {
              const flat = flatItems[vRow.index];
              if (!flat) return null;
              if (flat.kind === "group") {
                const grp = groupBy?.[flat.groupAccessorIndex ?? 0];
                const label = grp ? grp.label(flat.groupKey ?? "") : flat.groupKey;
                return (
                  <div
                    key={`grp-${flat.groupAccessorIndex}-${flat.groupKey}-${vRow.index}`}
                    role="row"
                    style={{
                      position: "absolute",
                      top: vRow.start,
                      left: 0,
                      right: 0,
                      height: vRow.size,
                    }}
                    className="flex items-center bg-muted/40 px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    {label as ReactNode}
                  </div>
                );
              }
              const row = flat.row!;
              const realIndex = flat.rowIndex ?? 0;
              const isFocused = focusedIndex === realIndex;
              const rowExtra =
                typeof rowClassName === "function"
                  ? rowClassName(row, realIndex)
                  : rowClassName;
              return (
                <div
                  key={keyExtractor(row, realIndex)}
                  role="row"
                  aria-rowindex={realIndex + 2}
                  tabIndex={onRowClick ? 0 : -1}
                  data-row-index={realIndex}
                  onClick={onRowClick ? () => onRowClick(row, realIndex) : undefined}
                  onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(row, realIndex) : undefined}
                  onFocus={() => setFocusedIndex(realIndex)}
                  style={{
                    position: "absolute",
                    top: vRow.start,
                    left: 0,
                    right: 0,
                    height: vRow.size,
                  }}
                  className={cn(
                    "flex items-center border-b border-border transition-colors",
                    onRowClick && "cursor-pointer hover:bg-muted",
                    isFocused && "bg-muted/60 ring-1 ring-ring",
                    rowExtra,
                  )}
                >
                  {finalColumns.map((col, ci) => (
                    <div
                      key={col.id ?? (typeof col.header === "string" ? col.header : undefined) ?? `cell-${ci}`}
                      role="gridcell"
                      aria-colindex={ci + 1}
                      style={col.width ? { width: col.width, minWidth: col.width } : undefined}
                      className={cn("flex items-center px-3", alignClass(col.align), col.className)}
                    >
                      {col.cell(row, realIndex)}
                    </div>
                  ))}
                  {rowActions ? (
                    <div className="ml-auto flex items-center pr-2" onClick={(e) => e.stopPropagation()}>
                      {rowActions(row, realIndex)}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>
      {footer}
      {isFetching && !isLoading ? <p className="text-xs text-muted-foreground">Refreshing…</p> : null}
    </div>
  );
}