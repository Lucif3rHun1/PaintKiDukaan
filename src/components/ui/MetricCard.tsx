import { type ElementType, type ReactNode } from "react";
import { Card } from "./Card";
import { Money } from "./Money";
import { Skeleton } from "./Skeleton";

function cnTone(...c: string[]): string {
  return c.filter(Boolean).join(" ");
}

export interface MetricCardProps {
  icon: ElementType<{ className?: string }>;
  label: string;
  children: ReactNode;
  loading?: boolean;
  tone?: "primary" | "success" | "warning" | "info" | "destructive";
  footer?: ReactNode;
}

const toneTextClasses: Record<NonNullable<MetricCardProps["tone"]>, string> = {
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning",
  info: "text-info",
  destructive: "text-destructive",
};

const toneIconBgClasses: Record<NonNullable<MetricCardProps["tone"]>, string> = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  info: "bg-info/10 text-info",
  destructive: "bg-destructive/10 text-destructive",
};

export function MetricCard({
  icon: Icon,
  label,
  children,
  loading,
  tone = "primary",
  footer,
}: MetricCardProps) {
  return (
    <Card className="flex flex-col">
      <Card.Body className="flex flex-1 flex-col gap-2">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{label}</span>
          <div className={cnTone("flex h-6 w-6 items-center justify-center rounded-md", toneIconBgClasses[tone])}>
            <Icon className="h-3.5 w-3.5" />
          </div>
        </div>
        {loading ? (
          <Skeleton className="h-8 w-28" />
        ) : (
          <div className={cnTone(toneTextClasses[tone])}>{children}</div>
        )}
        {footer && <div className="mt-auto pt-2">{footer}</div>}
      </Card.Body>
    </Card>
  );
}

export { Money };
