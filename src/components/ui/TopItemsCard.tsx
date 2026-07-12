import type { ReactNode } from "react";
import { Card } from "./Card";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";
import { Money } from "./Money";
import { cn } from "./cn";

export type TopItemsBadgeTone = "primary" | "warning" | "info" | "success" | "danger";

export interface TopItemsCardItem {
  /** Stable React key */
  id?: string | number;
  /** Display name (truncated with ellipsis if too long) */
  name: string;
  /** Optional secondary line under name */
  subtitle?: ReactNode;
  /** Optional trailing value (right-aligned, tabular-nums) */
  value?: ReactNode;
  /** Optional secondary trailing line under value */
  valueSubtitle?: ReactNode;
}

export interface TopItemsCardProps {
  title: string;
  subtitle?: ReactNode;
  items: TopItemsCardItem[] | undefined;
  loading?: boolean;
  badgeTone?: TopItemsBadgeTone;
  /** Skeleton count while loading. Defaults to 5. */
  skeletonRows?: number;
  /** Header action slot (right-aligned in card header) */
  headerAction?: ReactNode;
  /** Empty state shown when items array is empty (after loading). */
  emptyState?: { icon?: ReactNode; title: string; description?: string };
  /** Optional className for the Card */
  className?: string;
}

const toneClasses: Record<TopItemsBadgeTone, string> = {
  primary: "bg-primary/10 text-primary",
  warning: "bg-warning/10 text-warning",
  info: "bg-info/10 text-info",
  success: "bg-success/10 text-success",
  danger: "bg-destructive/10 text-destructive",
};

/**
 * Ranked-list card: numbered badge + truncated name + right-aligned value.
 * Used for "Top N items/customers/etc." patterns across Dashboard tabs.
 *
 * Items array is the source of truth; the component handles loading/empty
 * states so callers don't repeat the boilerplate.
 */
export function TopItemsCard({
  title,
  subtitle,
  items,
  loading,
  badgeTone = "primary",
  skeletonRows = 5,
  headerAction,
  emptyState,
  className,
}: TopItemsCardProps) {
  const tone = toneClasses[badgeTone];

  return (
    <Card className={className}>
      <Card.Header className={cn("flex items-center justify-between", !subtitle && !headerAction && "py-3")}>
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          {subtitle ? <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div> : null}
        </div>
        {headerAction}
      </Card.Header>
      <Card.Body className="p-0">
        {loading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: skeletonRows }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        ) : !items || items.length === 0 ? (
          emptyState ? (
            <div className="p-6">
              <EmptyState icon={emptyState.icon} title={emptyState.title} description={emptyState.description} />
            </div>
          ) : (
            <p className="py-6 text-center text-xs text-muted-foreground">No data</p>
          )
        ) : (
          <ul className={cn("divide-y divide-border")}>
            {items.map((item, i) => (
              <li
                key={item.id ?? `${item.name}-${i}`}
                className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span
                    className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium",
                      tone,
                    )}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{item.name}</div>
                    {item.subtitle ? <div className="truncate text-xs text-muted-foreground">{item.subtitle}</div> : null}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  {item.value ? <div className="text-xs tabular-nums text-muted-foreground">{item.value}</div> : null}
                  {item.valueSubtitle ? <div className="text-xs tabular-nums text-muted-foreground">{item.valueSubtitle}</div> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card.Body>
    </Card>
  );
}

/**
 * Convenience helper to format a "qty × ₹total" trailing value like the
 * original inline lists used (`{total_qty} × <Money compact />`).
 */
export function formatQtyValue(qty: number, paise: number) {
  return (
    <>
      {qty} × <Money paise={paise} compact />
    </>
  );
}