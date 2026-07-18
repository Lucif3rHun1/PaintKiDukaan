import type { LucideIcon } from "lucide-react";
import { ArrowRight, SlidersHorizontal } from "lucide-react";

import { Alert, Badge, Card, PageHeader, cn } from "../../../components/ui";

export interface SettingsCardItem {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  href: string;
}

export function SettingsCategory({ title, description, items }: { title: string; description: string; items: SettingsCardItem[] }) {
  return (
    <div className="space-y-5">
      <PageHeader title={title} description={`Settings. ${description}`} accent="slate" />

      <Card depth="raised">
        <Card.Body className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-primary ring-1 ring-border">
              <SlidersHorizontal className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-foreground">{title} configuration</h2>
                <Badge variant="info">{items.length} {items.length === 1 ? "area" : "areas"}</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">Choose an area below to review its current values and available actions.</p>
            </div>
          </div>
          <Badge variant="success">Ready to review</Badge>
        </Card.Body>
      </Card>

      <Alert variant="warning" title="Settings changes can affect live workflows">
        Review the current value on each page before saving. Open the area you need and use its primary action to apply changes.
      </Alert>

      <div className="grid gap-3 md:grid-cols-2">
        {items.map((item) => (
          <a
            key={item.id}
            href={item.href}
            className={cn(
              "group block p-1 no-underline outline-none transition-colors duration-fast",
              "rounded-xl focus-visible:ring-2 focus-visible:ring-primary/40",
            )}
          >
            <Card depth="raised" className="h-full transition-colors duration-fast group-hover:bg-surface-selected">
              <Card.Body>
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-foreground ring-1 ring-border transition-colors duration-fast group-hover:bg-primary/10 group-hover:text-primary">
                  <item.icon className="h-5 w-5" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-base font-semibold text-foreground">{item.title}</h2>
                  <p className="mt-1 text-sm leading-5 text-muted-foreground">{item.description}</p>
                </div>
                <span className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm font-medium text-primary transition-colors duration-fast group-hover:bg-primary/10">
                  Open
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </span>
              </div>
              </Card.Body>
            </Card>
          </a>
        ))}
      </div>
    </div>
  );
}
