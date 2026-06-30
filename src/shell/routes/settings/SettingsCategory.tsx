import type { LucideIcon } from "lucide-react";
import { ArrowRight } from "lucide-react";

import { Card, PageHeader, cn } from "../../../components/ui";

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

      <div className="grid gap-3 md:grid-cols-2">
        {items.map((item) => (
          <a
            key={item.id}
            href={item.href}
            className={cn(
              "group block p-1 no-underline outline-none transition-[border-color,box-shadow]",
              "rounded-xl focus-visible:ring-2 focus-visible:ring-primary/40",
            )}
          >
            <Card className="h-full border-border bg-card/40 p-4 transition-[border-color,box-shadow,background-color] group-hover:border-primary/30 group-hover:bg-card/60 group-hover:shadow-lg group-hover:shadow-primary/30">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground ring-1 ring-border transition-colors group-hover:bg-primary/15 group-hover:text-primary-foreground group-hover:ring-primary/30">
                  <item.icon className="h-5 w-5" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-base font-semibold text-foreground">{item.title}</h2>
                  <p className="mt-1 text-sm leading-5 text-muted-foreground">{item.description}</p>
                </div>
                <span className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm font-medium text-primary transition-colors group-hover:bg-primary/15 group-hover:text-primary-foreground">
                  Open
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </span>
              </div>
            </Card>
          </a>
        ))}
      </div>
    </div>
  );
}
