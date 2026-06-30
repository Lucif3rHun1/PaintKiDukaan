import { type ReactNode } from "react";
import { cn } from "./cn";

interface Props {
  title: string;
  description?: string;
  action?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Section({
  title,
  description,
  action,
  actions,
  className,
  children,
}: Props) {
  const rightSlot = actions ?? action;
  return (
    <section className={cn("space-y-3", className)}>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-foreground">{title}</h3>
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
