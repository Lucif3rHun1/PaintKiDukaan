import { type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Card } from "../../../components/ui";
import { MetricCard } from "./shared";

export type TopMetricTone = NonNullable<
  React.ComponentProps<typeof MetricCard>["tone"]
>;

export interface TopMetric {
  /** Stable identifier — used as React key + aria label */
  id: string;
  /** Short label shown above the value */
  label: string;
  /** Lucide icon component to display */
  icon: LucideIcon;
  /** Tone colour for the icon + value */
  tone: TopMetricTone;
  /** True while the underlying query is loading */
  loading: boolean;
  /** Value to display in the card body */
  value: ReactNode;
  /** Optional footer line (e.g. "vs yesterday", mini-list) */
  footer?: ReactNode;
}

interface TopMetricsRowProps {
  metrics: TopMetric[];
  /** aria-label for the wrapping section */
  label?: string;
}

/**
 * Top metrics grid above the tabbed Inventory / Business content.
 *
 * Sales-specific KPIs (Today's Sales, Items Sold Today) intentionally live
 * INSIDE the Business tab — the inventory tab does not need them. Adding a
 * new metric = push to the array.
 */
export function TopMetricsRow({ metrics, label = "Top metrics" }: TopMetricsRowProps) {
  return (
    <section aria-label={label} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {metrics.map((m) => (
          <MetricCard
            key={m.id}
            icon={m.icon}
            label={m.label}
            loading={m.loading}
            tone={m.tone}
            footer={m.footer}
          >
            {m.value}
          </MetricCard>
        ))}
      </div>
      {metrics.length === 0 ? (
        <Card className="p-4">
          <p className="text-sm text-muted-foreground">No metrics available.</p>
        </Card>
      ) : null}
    </section>
  );
}