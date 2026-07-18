import type { LucideIcon } from "lucide-react";
import { ArrowRight } from "lucide-react";

import { PageHeader, cn } from "../../../components/ui";

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
      <PageHeader title={title} description={description} accent="slate" />

      <nav aria-label={`${title} settings`} className="surface-flat overflow-hidden rounded-lg border border-border">
        {items.map((item) => (
          <a
            key={item.id}
            href={item.href}
            className={cn(
              "group flex min-h-20 items-center gap-3 border-b border-border px-4 py-3 no-underline outline-none transition-colors duration-fast last:border-b-0 hover:bg-muted/50 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 motion-reduce:transition-none",
            )}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-foreground ring-1 ring-border transition-colors duration-fast group-hover:bg-primary/10 group-hover:text-primary motion-reduce:transition-none">
              <item.icon className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-foreground">{item.title}</span>
              <span className="mt-0.5 block text-sm leading-5 text-muted-foreground">{item.description}</span>
            </span>
            <ArrowRight className="h-5 w-5 shrink-0 text-muted-foreground transition-transform duration-fast group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none" aria-hidden="true" />
          </a>
        ))}
      </nav>
    </div>
  );
}
