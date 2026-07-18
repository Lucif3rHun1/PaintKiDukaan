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
  blue: "border-b-2 border-b-page-blue",
  green: "border-b-2 border-b-page-green",
  amber: "border-b-2 border-b-page-amber",
  purple: "border-b-2 border-b-page-purple",
  red: "border-b-2 border-b-page-red",
  slate: "border-b border-border",
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
        "px-4 py-3 text-foreground",
        accentClasses[accent],
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground text-balance">{title}</h1>
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
