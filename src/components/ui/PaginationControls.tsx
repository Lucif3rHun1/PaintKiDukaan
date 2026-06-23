import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "./Button";

export interface PaginationControlsProps {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  className?: string;
}

export function PaginationControls({
  page,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  className = "",
}: PaginationControlsProps) {
  const firstItem = totalItems === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastItem = Math.min(totalItems, page * pageSize);

  return (
    <nav
      className={`flex flex-wrap items-center justify-between gap-3 text-sm ${className}`}
      aria-label="Pagination"
    >
      <p className="text-xs text-muted-foreground dark:text-muted-foreground">
        Showing <span className="font-medium tabular-nums">{firstItem}</span>–
        <span className="font-medium tabular-nums">{lastItem}</span> of{" "}
        <span className="font-medium tabular-nums">{totalItems}</span>
      </p>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          aria-label="Go to previous page"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Prev
        </Button>
        <span className="min-w-20 text-center text-xs text-muted-foreground dark:text-muted-foreground">
          Page <span className="font-medium tabular-nums">{page}</span> /{" "}
          <span className="font-medium tabular-nums">{totalPages}</span>
        </span>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          aria-label="Go to next page"
        >
          Next
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
