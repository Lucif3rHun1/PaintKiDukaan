import type { ReactNode } from "react";
import { Card } from "./Card";
import { EmptyState } from "./EmptyState";
import { SkeletonRow } from "./SkeletonRow";
import { Badge } from "./Badge";

export type ConcernStatusTone = "destructive" | "warning" | "info" | "success";

export interface ConcernCardItem {
  /** Stable React key */
  id?: string | number;
  /** Display name (truncated with ellipsis if too long) */
  name: string;
}

export interface ConcernCardProps<T extends ConcernCardItem = ConcernCardItem> {
  title: string;
  subtitle?: ReactNode;
  items: T[] | undefined;
  loading?: boolean;
  /** Computes the tone for the right-side status pill. */
  statusFn: (item: T) => ConcernStatusTone;
  /** Renders the content inside the status pill (e.g. "3 / min 5", "Out of stock"). */
  renderStatus: (item: T) => ReactNode;
  /** Skeleton count while loading. Defaults to 5. */
  skeletonRows?: number;
  /** Header action slot (right-aligned in card header). Use for "View all" links, filters, etc. */
  headerAction?: ReactNode;
  /** Empty state shown when items array is empty (after loading). */
  emptyState?: { icon?: ReactNode; title: string; description?: string };
  /** Optional className for the Card */
  className?: string;
}

const toneVariants: Record<ConcernStatusTone, "danger" | "warning" | "info" | "success"> = {
  destructive: "danger",
  warning: "warning",
  info: "info",
  success: "success",
};

/**
 * Problem-list card: left truncated name + right status pill.
 * Used for "items needing attention" patterns (low stock, dead stock, etc.)
 * across the dashboard. Items array is the source of truth; loading/empty
 * states are handled internally so callers don't repeat the boilerplate.
 */
export function ConcernCard<T extends ConcernCardItem>({
  title,
  subtitle,
  items,
  loading,
  statusFn,
  renderStatus,
  skeletonRows = 5,
  headerAction,
  emptyState,
  className,
}: ConcernCardProps<T>) {
  return (
    <Card className={className} size="sm">
      <Card.Header className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          {subtitle ? <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div> : null}
        </div>
        {headerAction}
      </Card.Header>
      <Card.Body className="p-0">
        {loading ? (
          <div className="p-3"><SkeletonRow count={skeletonRows} /></div>
        ) : !items || items.length === 0 ? (
          emptyState ? (
            <div className="px-3">
              <EmptyState icon={emptyState.icon} title={emptyState.title} description={emptyState.description} />
            </div>
          ) : (
            <EmptyState title="No concerns" className="py-8 sm:py-8" />
          )
        ) : (
          <ul className="divide-y divide-border">
            {items.map((item, i) => {
              const variant = toneVariants[statusFn(item)];
              return (
                <li
                  key={item.id ?? `${item.name}-${i}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
                  <Badge variant={variant} size="sm">
                    {renderStatus(item)}
                  </Badge>
                </li>
              );
            })}
          </ul>
        )}
      </Card.Body>
    </Card>
  );
}
