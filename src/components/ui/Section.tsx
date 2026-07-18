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
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <Heading className="text-balance text-lg font-semibold text-foreground">{title}</Heading>
          {description && (
            <p className="mt-0.5 max-w-3xl text-pretty text-xs leading-4 text-muted-foreground">{description}</p>
          )}
        </div>
        {rightSlot ? <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto">{rightSlot}</div> : null}
      </div>
      {children}
    </section>
  );
}
