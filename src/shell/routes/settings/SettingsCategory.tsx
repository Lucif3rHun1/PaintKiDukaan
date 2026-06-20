import type { LucideIcon } from "lucide-react";
import { ArrowRight } from "lucide-react";

import { Card, cn } from "../../../components/ui";

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
      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300/80">
          Settings
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">{title}</h1>
        <p className="max-w-3xl text-sm leading-6 text-zinc-400">{description}</p>
      </header>

      <div className="grid gap-3 md:grid-cols-2">
        {items.map((item) => (
          <a
            key={item.id}
            href={item.href}
            className={cn(
              "group block p-1 no-underline outline-none transition-[border-color,box-shadow]",
              "rounded-xl focus-visible:ring-2 focus-visible:ring-indigo-400/40",
            )}
          >
            <Card className="h-full border-white/5 bg-zinc-950/40 p-4 transition-[border-color,box-shadow,background-color] group-hover:border-indigo-400/30 group-hover:bg-zinc-900/60 group-hover:shadow-lg group-hover:shadow-indigo-950/30">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-zinc-300 ring-1 ring-white/5 transition-colors group-hover:bg-indigo-500/15 group-hover:text-indigo-200 group-hover:ring-indigo-400/30">
                  <item.icon className="h-5 w-5" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-base font-semibold text-zinc-100">{item.title}</h2>
                  <p className="mt-1 text-sm leading-5 text-zinc-400">{item.description}</p>
                </div>
                <span className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm font-medium text-indigo-300 transition-colors group-hover:bg-indigo-500/15 group-hover:text-indigo-200">
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
