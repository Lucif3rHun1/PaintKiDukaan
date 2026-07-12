import { type ElementType, type ReactNode } from "react";
import { cn } from "./cn";

interface Props {
  title: string;
  description?: string;
  action?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
  /** Heading element to render. Defaults to "h2". */
  as?: ElementType;
}

export function Section({
  title,
  description,
  action,
  actions,
  className,
  children,
  as: Heading = "h2",
}: Props) {
  const rightSlot = actions ?? action;
  return (
    <section className={cn("space-y-3", className)}>
      <div className="flex items-center justify-between">
        <div>
          <Heading className="text-lg font-semibold text-foreground">{title}</Heading>
          {description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          )}
        </div>
        {rightSlot}
      </div>
      {children}
    </section>
  );
}
