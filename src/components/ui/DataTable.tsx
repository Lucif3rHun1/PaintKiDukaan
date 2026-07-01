import { type ReactNode } from "react";
import { AlertCircle, RotateCcw } from "lucide-react";
import { cn } from "./cn";
import { Button } from "./Button";
import { SkeletonRow } from "./SkeletonRow";

export interface ColumnDef<T> {
  header: ReactNode;
  /** Unique id for the column. When omitted, the header string is used (if it is a string). */
  id?: string;
  /** Cell renderer. Receives the row and its index. */
  cell: (row: T, index: number) => ReactNode;
  /** Optional column-level className applied to every <td> and <th> in this column. */
  className?: string;
  /** Optional width (e.g. "120px", "20%"). Applied to both header and body cells. */
  width?: string;
  /** Text alignment for the column. */
  align?: "left" | "right" | "center";
}

export interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T>[];
  keyExtractor: (row: T, index: number) => string | number;
  caption?: ReactNode;
  loading?: boolean;
  /** Number of skeleton rows to render while loading. Defaults to 5. */
  skeletonRows?: number;
  emptyState?: ReactNode;
  error?: Error | string | null;
  onRetry?: () => void;
  /** Extra className for the outer overflow wrapper. */
  className?: string;
  /** Extra className for the <table> element. */
  tableClassName?: string;
  /** ClassName applied to every <tbody> row. Can be a string or a function of row + index. */
  rowClassName?: string | ((row: T, index: number) => string);
  onRowClick?: (row: T, index: number) => void;
  /** Whether the header row should stick on vertical scroll. */
  stickyHeader?: boolean;
  /** Optional header className for the sticky header background. */
  headerClassName?: string;
}



function alignClass(align?: "left" | "right" | "center"): string {
  if (align === "right") return "text-right";
  if (align === "center") return "text-center";
  return "text-left";
}

export function DataTable<T>({
  data,
  columns,
  keyExtractor,
  caption,
  loading = false,
  skeletonRows = 5,
  emptyState,
  error,
  onRetry,
  className,
  tableClassName,
  rowClassName,
  onRowClick,
  stickyHeader = false,
  headerClassName,
}: DataTableProps<T>) {
  const hasError = Boolean(error);
  const isEmpty = !loading && !hasError && data.length === 0;

  return (
    <div className={cn("overflow-x-auto rounded border border-border", className)}>
      <table className={cn("w-full text-sm", tableClassName)}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead
          className={cn(
            "text-left text-xs uppercase text-muted-foreground",
            stickyHeader && "sticky top-0 z-10",
            headerClassName ?? (stickyHeader ? "bg-card" : "border-b border-border bg-card"),
          )}
        >
          <tr className={stickyHeader ? "border-b border-border" : undefined}>
            {columns.map((col, i) => (
              <th
                key={col.id ?? (typeof col.header === "string" ? col.header : undefined) ?? `col-${i}`}
                scope="col"
                style={col.width ? { width: col.width, minWidth: col.width } : undefined}
                className={cn(
                  "px-3 py-2 font-medium",
                  alignClass(col.align),
                  col.className,
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-4">
                <SkeletonRow count={skeletonRows} />
              </td>
            </tr>
          ) : hasError ? (
            <tr>
              <td colSpan={columns.length}>
                <div className="flex flex-col items-center justify-center gap-3 px-3 py-10 text-center">
                  <AlertCircle className="h-8 w-8 text-destructive" aria-hidden="true" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">Failed to load data</p>
                    <p className="max-w-xs text-xs text-muted-foreground">
                      {typeof error === "string" ? error : error?.message ?? "Something went wrong."}
                    </p>
                  </div>
                  {onRetry ? (
                    <Button type="button" size="sm" variant="secondary" icon={RotateCcw} onClick={onRetry}>
                      Retry
                    </Button>
                  ) : null}
                </div>
              </td>
            </tr>
          ) : isEmpty ? (
            <tr>
              <td colSpan={columns.length}>
                {emptyState ?? (
                  <p className="px-3 py-8 text-center text-sm text-muted-foreground">No data available.</p>
                )}
              </td>
            </tr>
          ) : (
            data.map((row, index) => {
              const rowExtra =
                typeof rowClassName === "function" ? rowClassName(row, index) : rowClassName;
              return (
                <tr
                  key={keyExtractor(row, index)}
                  className={cn(
                    "border-b border-border transition-colors last:border-b-0",
                    onRowClick && "cursor-pointer hover:bg-muted",
                    !onRowClick && "hover:bg-muted/50",
                    rowExtra,
                  )}
                  onClick={onRowClick ? () => onRowClick(row, index) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  role={onRowClick ? "button" : undefined}
                  onKeyDown={onRowClick ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onRowClick(row, index);
                    }
                  } : undefined}
                >
                {columns.map((col, i) => (
                  <td
                    key={col.id ?? (typeof col.header === "string" ? col.header : undefined) ?? `cell-${i}`}
                    style={col.width ? { width: col.width, minWidth: col.width } : undefined}
                    className={cn("px-3 py-2", alignClass(col.align), col.className)}
                  >
                      {col.cell(row, index)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
