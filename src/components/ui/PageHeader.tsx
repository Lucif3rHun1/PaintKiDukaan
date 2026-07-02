import type { ReactNode } from "react";
import { cn } from "./cn";

export type PageHeaderAccent = "blue" | "green" | "amber" | "purple" | "red" | "slate";

export interface PageHeaderProps {
  readonly title: string;
  readonly description?: string;
  readonly accent?: PageHeaderAccent;
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
}

const accentClasses: Record<PageHeaderAccent, string> = {
  blue: "border-l-page-blue bg-page-blue/5",
  green: "border-l-page-green bg-page-green/5",
  amber: "border-l-page-amber bg-page-amber/5",
  purple: "border-l-page-purple bg-page-purple/5",
  red: "border-l-page-red bg-page-red/5",
  slate: "border-l-page-slate bg-page-slate/5",
};

export function PageHeader({
  title,
  description,
  accent = "slate",
  actions,
  children,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        "rounded-xl border border-l bg-card px-4 py-3 text-card-foreground shadow-sm shadow-foreground/5",
        accentClasses[accent],
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-foreground text-balance">{title}</h1>
          {description ? (
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground text-pretty">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children ? <div className="mt-3 border-t border-border pt-3">{children}</div> : null}
    </header>
  );
}
